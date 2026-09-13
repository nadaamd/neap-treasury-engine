/**
 * Core of the confidential handler: from treasury state to a signable report.
 *
 * This module knows nothing about the CRE SDK. It takes a state and returns a report — so
 * it is testable with no enclave, no network and no chain. The CRE handler proper reduces
 * to fetching a secret, making two HTTP calls and calling this function.
 *
 * That is the direct consequence of D9: the engine is a pure function, portable as is.
 * This file is the adapter that connects it to the chain's format, and it is
 * pur lui aussi.
 */

import { decide } from '../../engine/src/policy/decide.ts';
import type { DecisionInput } from '../../engine/src/policy/decide.ts';
import { ordersCommitment } from '../../engine/src/onchain/abi.ts';
import type { OnchainOrder } from '../../engine/src/onchain/abi.ts';
import { keccak256, toHex } from '../../engine/src/onchain/keccak.ts';
import type { Currency } from '../../data/src/types.ts';
import type { HandlerInput, HandlerOutput, PlannedOrder } from './types.ts';

const encoder = new TextEncoder();

/** Stable hash of a JSON value, insensitive to key enumeration order. */
function stableHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort());
    }
    return v;
  });
  return toHex(keccak256(encoder.encode(canonical)));
}

/**
 * A derived salt, never a random one.
 *
 * It must be unpredictable to an observer — otherwise the commitment hides nothing — and
 * reproducible inside the enclave, since a pure function has no randomness. Deriving it
 * from a secret and the (epoch, nonce) pair satisfies both, and incidentally guarantees
 * that no salt is reused across reports.
 */
export function deriveSalt(seed: string, epoch: number, nonce: number): string {
  return toHex(keccak256(encoder.encode(`${seed}|${epoch}|${nonce}`)));
}

function toUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`invalid amount: ${amount}`);
  return BigInt(Math.round(amount * 10 ** decimals));
}

export function buildReport(input: HandlerInput): HandlerOutput {
  const { treasury, market, chain, saltSeed, now } = input;

  const decisionInput: DecisionInput = {
    epoch: treasury.epoch,
    nonce: treasury.nonce,
    policyVersion: treasury.policyVersion,
    bandParamsHash: treasury.bandParamsHash,
    numeraire: chain.numeraire,
    currencies: chain.currencies,
    balances: treasury.balances,
    commitments: treasury.commitments,
    policies: Object.fromEntries(
      chain.currencies.map((c) => [c, { ...treasury.limits[c]!, bands: treasury.bands[c]! }]),
    ),
    risk: treasury.risk,
    currentVol: market.currentVol,
    residuals: market.residuals,
    marketTimestamp: market.timestamp,
    now,
  };

  const decision = decide(decisionInput);
  const salt = deriveSalt(saltSeed, treasury.epoch, treasury.nonce);

  // Public inputs are committed separately: the contract cannot verify them, but their
  // hash makes after-the-fact audit possible.
  const inputsHash = stableHash({
    timestamp: market.timestamp,
    rates: market.rates,
    gasUsdc: market.gasUsdc,
    vol: market.currentVol,
  });

  const orders: PlannedOrder[] = [];
  for (const o of decision.orders) {
    const buysForeign = o.sell === chain.numeraire;
    const foreign = buysForeign ? o.buy : o.sell;
    const rate = market.rates[foreign];
    if (rate === undefined || rate <= 0) throw new RangeError(`missing rate for ${foreign}`);

    // The engine reasons in numeraire equivalent; the chain reasons in token units.
    const keep = (10_000 - chain.slippageBps) / 10_000;
    const amountIn = buysForeign ? o.amount : o.amount * rate;
    const grossOut = buysForeign ? o.amount * rate : o.amount;

    orders.push({
      sell: chain.tokens[o.sell]!,
      buy: chain.tokens[o.buy]!,
      amountIn: toUnits(amountIn, chain.decimals),
      minAmountOut: toUnits(grossOut * keep, chain.decimals),
    });
  }

  /**
   * Gross notional must be computed **exactly the way the vault recomputes it**: the
   * incoming amount for a buy, the minimum outgoing amount for a sell. Any other
   * convention would make execution fail on `NotionalMismatch`, after a valid signature
   * and a human approval — the worst possible moment to discover a convention mismatch.
   */
  const grossNotional = orders.reduce(
    (a, o) => a + (o.sell === chain.tokens[chain.numeraire] ? o.amountIn : o.minAmountOut),
    0n,
  );

  const onchainOrders: OnchainOrder[] = orders.map((o) => ({
    sell: o.sell,
    buy: o.buy,
    amountIn: o.amountIn,
    minAmountOut: o.minAmountOut,
  }));

  const commitment =
    orders.length > 0 ? ordersCommitment(onchainOrders, salt) : `0x${'00'.repeat(32)}`;

  return {
    status: decision.status,
    reason: decision.reason,
    report: {
      epoch: BigInt(treasury.epoch),
      nonce: BigInt(treasury.nonce),
      expiry: BigInt(Math.floor(now / 1000) + chain.validitySec),
      inputsTimestamp: BigInt(Math.floor(market.timestamp / 1000)),
      policyVersion: BigInt(treasury.policyVersion),
      bandParamsHash: treasury.bandParamsHash,
      inputsHash,
      ordersCommitment: commitment,
      esBeforeBps: BigInt(decision.metrics.esBeforeBps),
      esAfterBps: BigInt(decision.metrics.esAfterBps),
      costEstimate: toUnits(decision.metrics.costEstimate, chain.decimals),
      grossNotional,
    },
    reveal: { orders, salt },
  };
}

/** In-scope currencies, re-exported for the handler. */
export type { Currency };
