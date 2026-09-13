/**
 * The decision function — the body of the confidential handler (decisions D5 and D9).
 *
 * ─── What this function is ────────────────────────────────────────────────────
 * A **pure function**: same inputs, same outputs, no I/O, no clock, no randomness. It
 * runs identically inside the Chainlink CRE TEE handler and in a local runner, which
 * makes the fallback plan free — it is the same code.
 *
 * ─── Why it is short ──────────────────────────────────────────────────────────
 * Everything expensive — solving the bands, calibrating volatility, shrinkage, the tail
 * — depends only on *parameters*, not on *state*. That work happens outside the enclave
 * and is committed on-chain through `bandParamsHash` (D5). What remains here is only
 * what touches positions: compare state against bands, measure risk, emit a plan. That
 * split is what makes the confidentiality claim stateable in one sentence.
 *
 * ─── Why there is only one decision rule ──────────────────────────────────────
 * The spec initially had two competing rules: the band, and a cost/benefit test on VaR.
 * They could contradict each other. The band is not an input of the system, it is the
 * **result** of minimising J — which already contains carry, fixed cost, variable cost,
 * FX risk and breach risk. Adding a second economic filter here would charge the same
 * trade-offs twice. The online decision is therefore deliberately trivial: outside the
 * band, return to target. All the intelligence lives in computing the bands.
 */

import type { Currency } from '../../../data/src/types.ts';
import type { Bands } from '../bands/millerOrr.ts';
import { executionCost } from '../bands/simulate.ts';
import type { CostParams } from '../bands/simulate.ts';
import { conditionalCovariance } from '../risk/conditional.ts';
import { filteredHistoricalES, normalVaR, portfolioSigma, Z_99 } from '../risk/measures.ts';

export type DecisionStatus = 'NOOP' | 'PROPOSE' | 'REJECTED';

export interface Order {
  /** Currency sold. */
  readonly sell: Currency;
  /** Currency bought. */
  readonly buy: Currency;
  /** Amount in numeraire equivalent, already quantised. */
  readonly amount: number;
}

/** A known upcoming commitment. A *certain* commitment reduces the available balance; a
 *  probable one merely reshapes the distribution and is not deducted here. */
export interface Commitment {
  readonly currency: Currency;
  readonly amount: number;
  readonly dueEpoch: number;
  readonly certain: boolean;
}

export interface CurrencyPolicy {
  readonly bands: Bands;
  readonly costs: CostParams;
  /** Cap on a single order. */
  readonly maxSingleOrder: number;
  /** Settlement delay of the rail, in days — a slow rail leaves the exposure open longer. */
  readonly settlementDays: number;
}

export interface RiskParams {
  readonly horizonDays: number;
  readonly alpha: number;
  readonly basisHaircutBps: number;
  /** Order quantisation step (D6). */
  readonly lotSize: number;
  /** Below this, an order is dust and is not emitted. */
  readonly minOrder: number;
  /** Above this, human approval is required. */
  readonly autoApproveThreshold: number;
  /** Cap on cumulative notional over the epoch. */
  readonly maxPerEpoch: number;
  /** Minimum balance to preserve in the funding currency. */
  readonly fundingFloor: number;
  /** Maximum tolerated age of market data, in seconds. */
  readonly maxStalenessSec: number;
}

export interface DecisionInput {
  readonly epoch: number;
  readonly nonce: number;
  readonly policyVersion: number;
  readonly bandParamsHash: string;

  /** Funding currency, the system's numeraire. */
  readonly numeraire: Currency;
  /** Currencies carrying a band, excluding the numeraire. */
  readonly currencies: readonly Currency[];

  /** — confidential state — */
  readonly balances: Readonly<Record<string, number>>;
  readonly commitments: readonly Commitment[];

  /** — parameters, committed on-chain through bandParamsHash — */
  readonly policies: Readonly<Record<string, CurrencyPolicy>>;
  readonly risk: RiskParams;

  /** — market, public — */
  readonly currentVol: readonly number[];
  readonly residuals: readonly (readonly number[])[];
  readonly marketTimestamp: number;
  readonly now: number;
}

export interface DecisionMetrics {
  /** ES relative to gross exposure, in basis points — never as an amount (D6). */
  readonly esBeforeBps: number;
  readonly esAfterBps: number;
  readonly var99BeforeBps: number;
  readonly var99AfterBps: number;
  /** Execution risk: ES over the settlement horizon of the orders, in basis points. */
  readonly settlementRiskBps: number;
  readonly costEstimate: number;
}

export interface Decision {
  readonly status: DecisionStatus;
  readonly reason: string;
  readonly orders: readonly Order[];
  readonly requiresApproval: boolean;
  readonly metrics: DecisionMetrics;
  /** Canonical encoding of the orders — hashing happens at the boundary, not here. */
  readonly ordersCanonical: string;
  readonly epoch: number;
  readonly nonce: number;
  readonly policyVersion: number;
  readonly bandParamsHash: string;
}

const EMPTY_METRICS: DecisionMetrics = {
  esBeforeBps: 0,
  esAfterBps: 0,
  var99BeforeBps: 0,
  var99AfterBps: 0,
  settlementRiskBps: 0,
  costEstimate: 0,
};

/** Quantise down onto the lot step — never up: a rounding must not push an amount
 *  across a cap. */
function quantize(amount: number, lot: number): number {
  if (lot <= 0) return amount;
  return Math.floor(amount / lot) * lot;
}

/** Canonical encoding, stable and independent of iteration order. */
export function canonicalizeOrders(orders: readonly Order[]): string {
  return orders
    .map((o) => `${o.sell}>${o.buy}:${o.amount}`)
    .sort()
    .join('|');
}

export function decide(input: DecisionInput): Decision {
  const {
    epoch,
    nonce,
    policyVersion,
    bandParamsHash,
    numeraire,
    currencies,
    balances,
    commitments,
    policies,
    risk,
  } = input;

  const envelope = { epoch, nonce, policyVersion, bandParamsHash };

  // 1. Market data freshness. The contract will re-run this check, but deciding on
  //    stale prices and then being rejected wastes an epoch.
  const ageSec = (input.now - input.marketTimestamp) / 1000;
  if (ageSec > risk.maxStalenessSec || ageSec < 0) {
    return {
      status: 'REJECTED',
      reason: `stale market data: ${ageSec.toFixed(0)} s > ${risk.maxStalenessSec} s`,
      orders: [],
      requiresApproval: false,
      metrics: EMPTY_METRICS,
      ordersCanonical: '',
      ...envelope,
    };
  }

  // 2. Available balance: subtract certain commitments falling due within the horizon.
  //    Probable commitments are not deducted — they are already in the flow distribution
  //    that produced the bands.
  const available: Record<string, number> = {};
  for (const c of [numeraire, ...currencies]) available[c] = balances[c] ?? 0;
  for (const k of commitments) {
    if (k.certain && k.dueEpoch <= epoch + 1) {
      available[k.currency] = (available[k.currency] ?? 0) - k.amount;
    }
  }

  // 3. Deviation from the bands. The system's only decision rule.
  const raw: { currency: Currency; delta: number }[] = [];
  for (const c of currencies) {
    const policy = policies[c];
    if (!policy) continue;
    const b = available[c]!;
    if (b < policy.bands.lower) raw.push({ currency: c, delta: policy.bands.target - b });
    else if (b > policy.bands.upper) raw.push({ currency: c, delta: policy.bands.target - b });
  }

  // 4. Quantisation, dust, single-order cap.
  let candidates = raw
    .map(({ currency, delta }) => {
      const policy = policies[currency]!;
      const sign = Math.sign(delta);
      const capped = Math.min(Math.abs(delta), policy.maxSingleOrder);
      return { currency, signed: sign * quantize(capped, risk.lotSize) };
    })
    .filter((o) => Math.abs(o.signed) >= risk.minOrder);

  // 5. Funding constraint: you can only buy what the numeraire allows, floor preserved.
  //    Buys are scaled down pro rata, sells are not — they replenish the numeraire.
  const buys = candidates.filter((o) => o.signed > 0);
  const sells = candidates.filter((o) => o.signed < 0);
  const proceeds = sells.reduce((a, o) => a - o.signed, 0);
  const needed = buys.reduce((a, o) => a + o.signed, 0);
  const spendable = Math.max(0, (available[numeraire] ?? 0) + proceeds - risk.fundingFloor);

  let fundingScale = 1;
  if (needed > spendable && needed > 0) fundingScale = spendable / needed;

  // 6. Notional cap over the epoch.
  const grossAfterFunding = needed * fundingScale + proceeds;
  const epochScale =
    grossAfterFunding > risk.maxPerEpoch && grossAfterFunding > 0
      ? risk.maxPerEpoch / grossAfterFunding
      : 1;

  candidates = candidates
    .map((o) => ({
      currency: o.currency,
      signed: quantize(
        Math.abs(o.signed) * (o.signed > 0 ? fundingScale : 1) * epochScale,
        risk.lotSize,
      ) * Math.sign(o.signed),
    }))
    .filter((o) => Math.abs(o.signed) >= risk.minOrder);

  const orders: Order[] = candidates.map((o) =>
    o.signed > 0
      ? { sell: numeraire, buy: o.currency, amount: o.signed }
      : { sell: o.currency, buy: numeraire, amount: -o.signed },
  );

  // 7. Risk measured before and after. A currency's exposure is its balance:
  //    unhedged pre-funding *is* a directional position nobody chose.
  const before = currencies.map((c) => available[c] ?? 0);
  const after = before.slice();
  candidates.forEach((o) => {
    const i = currencies.indexOf(o.currency);
    if (i >= 0) after[i] = after[i]! + o.signed;
  });

  const { sigma } = conditionalCovariance(input.residuals, input.currentVol);
  const grossBefore = before.reduce((a, x) => a + Math.abs(x), 0);
  const toBps = (value: number, base: number) => (base > 0 ? Math.round((value / base) * 10_000) : 0);

  const esOf = (w: number[], horizonDays: number) =>
    filteredHistoricalES({
      residuals: input.residuals,
      currentVol: input.currentVol,
      weights: w,
      horizonDays,
      alpha: risk.alpha,
    }).es;

  const esBefore = esOf(before, risk.horizonDays);
  const esAfter = esOf(after, risk.horizonDays);
  const varBefore = normalVaR(portfolioSigma(before, sigma), risk.horizonDays, Z_99);
  const varAfter = normalVaR(portfolioSigma(after, sigma), risk.horizonDays, Z_99);

  // Execution risk: every order stays exposed until it settles. A slow rail (T+2)
  // therefore carries far more risk than a rail with sub-second finality, at equal
  // size — that is the hidden cost of a corridor without stablecoins.
  let settlementRisk = 0;
  for (const o of candidates) {
    const policy = policies[o.currency]!;
    const leg = currencies.map((c) => (c === o.currency ? Math.abs(o.signed) : 0));
    settlementRisk += esOf(leg, Math.max(policy.settlementDays, risk.horizonDays));
  }

  let costEstimate = 0;
  for (const o of candidates) {
    const policy = policies[o.currency]!;
    costEstimate += policy.costs.gammaFixed + executionCost(o.signed, policy.costs);
  }

  const gross = orders.reduce((a, o) => a + o.amount, 0);
  const metrics: DecisionMetrics = {
    esBeforeBps: toBps(esBefore, grossBefore),
    esAfterBps: toBps(esAfter, grossBefore),
    var99BeforeBps: toBps(varBefore, grossBefore),
    var99AfterBps: toBps(varAfter, grossBefore),
    settlementRiskBps: toBps(settlementRisk, grossBefore),
    costEstimate,
  };

  if (orders.length === 0) {
    return {
      status: 'NOOP',
      reason: 'every available balance is inside its band',
      orders: [],
      requiresApproval: false,
      metrics,
      ordersCanonical: '',
      ...envelope,
    };
  }

  return {
    status: 'PROPOSE',
    reason:
      fundingScale < 1
        ? 'plan scaled down by the funding constraint'
        : epochScale < 1
          ? 'plan scaled down by the epoch notional cap'
          : 'deviation from the bands',
    orders,
    requiresApproval: gross > risk.autoApproveThreshold,
    metrics,
    ordersCanonical: canonicalizeOrders(orders),
    ...envelope,
  };
}
