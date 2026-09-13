/** Decision function tests — SPEC §4.1, decisions D5, D6, D9. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RISK_CURRENCIES, simulateMarket } from '../../data/src/market.ts';
import { standardizedResiduals } from '../src/risk/residuals.ts';
import { canonicalizeOrders, decide } from '../src/policy/decide.ts';
import type { Commitment, CurrencyPolicy, DecisionInput } from '../src/policy/decide.ts';
import type { Currency } from '../../data/src/types.ts';

const MARKET = simulateMarket(4242, 800);
const { residuals, currentVol } = standardizedResiduals(MARKET.returns, RISK_CURRENCIES);

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

const costs = {
  gammaFixed: 0.02,
  spreadBps: 2,
  etaImpact: 0.05,
  depth: 5_000_000,
  carryRate: 0.06 / 365 / 96,
  kappa: 0.1,
  esPerUnit: 0.001,
  breachCost: 50_000,
};

function policy(over: Partial<CurrencyPolicy> = {}): CurrencyPolicy {
  return {
    bands: { lower: 400_000, target: 600_000, upper: 900_000 },
    costs,
    maxSingleOrder: 2_000_000,
    settlementDays: 1 / 96,
    ...over,
  };
}

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    epoch: 100,
    nonce: 7,
    policyVersion: 3,
    bandParamsHash: '0xabc',
    numeraire: 'USD',
    currencies: RISK_CURRENCIES as readonly Currency[],
    balances: { USD: 10_000_000, EUR: 600_000, GBP: 600_000, BRL: 600_000 },
    commitments: [],
    policies: { EUR: policy(), GBP: policy(), BRL: policy({ settlementDays: 2 }) },
    risk: {
      horizonDays: 1 / 96,
      alpha: 0.975,
      basisHaircutBps: 50,
      lotSize: 10_000,
      minOrder: 20_000,
      autoApproveThreshold: 1_000_000,
      maxPerEpoch: 5_000_000,
      fundingFloor: 1_000_000,
      maxStalenessSec: 60,
    },
    currentVol,
    residuals,
    marketTimestamp: NOW - 5_000,
    now: NOW,
    ...over,
  };
}

describe('guardrails', () => {
  test('stale market data causes the decision to be rejected', () => {
    const d = decide(input({ marketTimestamp: NOW - 600_000 }));
    assert.equal(d.status, 'REJECTED');
    assert.match(d.reason, /stale/);
    assert.equal(d.orders.length, 0);
  });

  test('a market timestamp in the future is rejected too', () => {
    const d = decide(input({ marketTimestamp: NOW + 60_000 }));
    assert.equal(d.status, 'REJECTED');
  });

  test('the envelope is copied verbatim — replay protection on the contract side', () => {
    const d = decide(input());
    assert.equal(d.epoch, 100);
    assert.equal(d.nonce, 7);
    assert.equal(d.policyVersion, 3);
    assert.equal(d.bandParamsHash, '0xabc');
  });
});

describe('decision rule — the band, and nothing else', () => {
  test('inside the bands, no action', () => {
    const d = decide(input());
    assert.equal(d.status, 'NOOP');
    assert.equal(d.orders.length, 0);
  });

  test('below the lower threshold, buy back up to target', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 } }));
    assert.equal(d.status, 'PROPOSE');
    assert.equal(d.orders.length, 1);
    assert.deepEqual(d.orders[0], { sell: 'USD', buy: 'EUR', amount: 500_000 });
  });

  test('above the upper threshold, sweep the excess', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 1_500_000, GBP: 600_000, BRL: 600_000 } }));
    assert.deepEqual(d.orders[0], { sell: 'EUR', buy: 'USD', amount: 900_000 });
  });

  test('several currencies outside their band produce several orders', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 1_500_000, BRL: 600_000 } }));
    assert.equal(d.orders.length, 2);
  });

  /**
   * Structural property: the target sitting strictly inside the band, any crossing
   * produces an order of at least the smaller half-width — here
   * min(target − lower, upper − target) = $200k. A balance at $385k therefore does not
   * generate a $15k order but a $215k one: you return to the target, not to the
   * threshold. That is the Miller-Orr mechanism, and it is what avoids rebalancing
   * endlessly at the edge of the band.
   */
  test('crossing the threshold returns to the target, not to the threshold', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 385_000, GBP: 600_000, BRL: 600_000 } }));
    // 600,000 − 385,000 = 215,000, quantised down onto the 10,000 lot.
    assert.equal(d.orders[0]!.amount, 210_000);
  });

  test('the dust filter applies after scaling down, never before', () => {
    const d = decide(
      input({
        balances: { USD: 1_010_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 },
        risk: { ...input().risk, fundingFloor: 1_000_000, minOrder: 20_000 },
      }),
    );
    assert.equal(d.status, 'NOOP', 'an order scaled down to $10k is dust and must not be emitted');
  });
});

describe('commitments', () => {
  test('a certain commitment reduces the available balance and can trigger an order', () => {
    const commitments: Commitment[] = [
      { currency: 'EUR', amount: 300_000, dueEpoch: 101, certain: true },
    ];
    const d = decide(input({ commitments }));
    assert.equal(d.status, 'PROPOSE');
    assert.equal(d.orders[0]!.buy, 'EUR');
  });

  test('a probable commitment is not deducted: it is already in the band distribution', () => {
    const commitments: Commitment[] = [
      { currency: 'EUR', amount: 300_000, dueEpoch: 101, certain: false },
    ];
    assert.equal(decide(input({ commitments })).status, 'NOOP');
  });

  test('a commitment outside the horizon is not deducted', () => {
    const commitments: Commitment[] = [
      { currency: 'EUR', amount: 300_000, dueEpoch: 500, certain: true },
    ];
    assert.equal(decide(input({ commitments })).status, 'NOOP');
  });
});

describe('quantisation and caps (D6)', () => {
  test('amounts are multiples of the lot step', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 137_777, GBP: 600_000, BRL: 600_000 } }));
    assert.equal(d.orders[0]!.amount % 10_000, 0);
  });

  test('quantisation rounds down, never up', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 137_777, GBP: 600_000, BRL: 600_000 } }));
    assert.ok(d.orders[0]!.amount <= 600_000 - 137_777);
  });

  test('the single-order cap is respected', () => {
    const d = decide(
      input({
        balances: { USD: 50_000_000, EUR: 0, GBP: 600_000, BRL: 600_000 },
        policies: { EUR: policy({ maxSingleOrder: 250_000 }), GBP: policy(), BRL: policy() },
      }),
    );
    assert.equal(d.orders[0]!.amount, 250_000);
  });

  test('the epoch notional cap scales the plan down pro rata', () => {
    const d = decide(
      input({
        balances: { USD: 50_000_000, EUR: 0, GBP: 0, BRL: 0 },
        risk: { ...input().risk, maxPerEpoch: 900_000 },
      }),
    );
    const gross = d.orders.reduce((a, o) => a + o.amount, 0);
    assert.ok(gross <= 900_000, `notional ${gross} above the cap`);
    assert.match(d.reason, /notional cap/);
  });
});

describe('funding constraint', () => {
  test('you cannot buy beyond the available numeraire, floor preserved', () => {
    const d = decide(
      input({
        balances: { USD: 1_300_000, EUR: 0, GBP: 0, BRL: 0 },
        risk: { ...input().risk, fundingFloor: 1_000_000 },
      }),
    );
    const spent = d.orders.reduce((a, o) => a + (o.sell === 'USD' ? o.amount : 0), 0);
    assert.ok(spent <= 300_000, `spend ${spent} above what is available`);
    assert.match(d.reason, /funding/);
  });

  test('sale proceeds fund purchases in the same epoch', () => {
    const d = decide(
      input({
        balances: { USD: 1_000_000, EUR: 0, GBP: 3_000_000, BRL: 600_000 },
        risk: { ...input().risk, fundingFloor: 1_000_000 },
      }),
    );
    const buy = d.orders.find((o) => o.buy === 'EUR');
    assert.ok(buy && buy.amount > 0, 'the GBP sale should have funded the EUR purchase');
  });
});

describe('human approval', () => {
  test('below the threshold, automatic execution', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 300_000, GBP: 600_000, BRL: 600_000 } }));
    assert.equal(d.requiresApproval, false);
  });

  test('above the threshold, approval required', () => {
    const d = decide(
      input({
        balances: { USD: 10_000_000, EUR: 0, GBP: 0, BRL: 600_000 },
        risk: { ...input().risk, autoApproveThreshold: 500_000 },
      }),
    );
    assert.equal(d.requiresApproval, true);
  });
});

describe('risk metrics', () => {
  /**
   * Topping up **increases** FX exposure, hence ES. That is not an anomaly: the
   * pre-funded balance *is* the directional position nobody chose. The band has already
   * traded off that extra risk against the reduction in breach risk, through the κ·ES
   * term of the objective. A decision that always lowered ES would be a decision that
   * ignores breach risk.
   */
  test('rebuilding a buffer increases ES — and that is the expected behaviour', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 } }));
    assert.ok(
      d.metrics.esAfterBps > d.metrics.esBeforeBps,
      `ES ${d.metrics.esBeforeBps} → ${d.metrics.esAfterBps} bps`,
    );
  });

  test('sweeping an excess reduces ES', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 3_000_000, GBP: 600_000, BRL: 600_000 } }));
    assert.ok(d.metrics.esAfterBps < d.metrics.esBeforeBps);
  });

  test('metrics are published in basis points, never as amounts (D6)', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 } }));
    for (const v of [d.metrics.esBeforeBps, d.metrics.esAfterBps, d.metrics.var99BeforeBps]) {
      assert.ok(Number.isInteger(v), `non-integer metric: ${v}`);
      assert.ok(Math.abs(v) < 2 ** 31, 'metric exceeds an int32');
    }
  });

  /**
   * The corridor without a stablecoin settles at T+2: at equal size, the exposure stays
   * open 192 times longer than a settlement with sub-second finality, so execution risk
   * is ~√192 ≈ 14 times higher. That is the hidden cost of the slow rail, and it appears
   * nowhere in the quoted fees.
   */
  test('the slow rail carries far more settlement risk, at equal size', () => {
    const fast = decide(
      input({
        balances: { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 },
        policies: { EUR: policy(), GBP: policy(), BRL: policy() },
      }),
    );
    const slow = decide(
      input({
        balances: { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 },
        policies: { EUR: policy({ settlementDays: 2 }), GBP: policy(), BRL: policy() },
      }),
    );
    assert.deepEqual(fast.orders, slow.orders, 'the plans must be identical');
    assert.ok(
      slow.metrics.settlementRiskBps > 5 * fast.metrics.settlementRiskBps,
      `slow rail ${slow.metrics.settlementRiskBps} bps vs fast ${fast.metrics.settlementRiskBps} bps`,
    );
  });

  test('the estimated cost covers both fixed and variable cost', () => {
    const d = decide(input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 } }));
    assert.ok(d.metrics.costEstimate > costs.gammaFixed);
  });
});

describe('purity and canonical encoding (D9, D6)', () => {
  test('same inputs ⇒ identical outputs', () => {
    const i = input({ balances: { USD: 10_000_000, EUR: 100_000, GBP: 1_400_000, BRL: 600_000 } });
    assert.deepEqual(decide(i), decide(i));
  });

  test('canonical encoding does not depend on enumeration order', () => {
    const a = canonicalizeOrders([
      { sell: 'USD', buy: 'EUR', amount: 500_000 },
      { sell: 'GBP', buy: 'USD', amount: 200_000 },
    ]);
    const b = canonicalizeOrders([
      { sell: 'GBP', buy: 'USD', amount: 200_000 },
      { sell: 'USD', buy: 'EUR', amount: 500_000 },
    ]);
    assert.equal(a, b);
  });

  test('a different amount produces a different encoding — the commitment binds', () => {
    const a = canonicalizeOrders([{ sell: 'USD', buy: 'EUR', amount: 500_000 }]);
    const b = canonicalizeOrders([{ sell: 'USD', buy: 'EUR', amount: 510_000 }]);
    assert.notEqual(a, b);
  });

  test('a NOOP publishes no encoding', () => {
    assert.equal(decide(input()).ordersCanonical, '');
  });
});
