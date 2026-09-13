/** Tests for the core of the confidential handler. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RISK_CURRENCIES, simulateMarket } from '../../data/src/market.ts';
import { standardizedResiduals } from '../../engine/src/risk/residuals.ts';
import { buildReport, deriveSalt } from '../handler/buildReport.ts';
import type { ChainConfig, HandlerInput } from '../handler/types.ts';
import type { Currency } from '../../data/src/types.ts';

const MARKET = simulateMarket(4242, 400);
const { residuals, currentVol } = standardizedResiduals(MARKET.returns, RISK_CURRENCIES);
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

const TOKENS: Record<string, string> = {
  USD: '0x1111111111111111111111111111111111111111',
  EUR: '0x2222222222222222222222222222222222222222',
  GBP: '0x3333333333333333333333333333333333333333',
  BRL: '0x4444444444444444444444444444444444444444',
};

const CHAIN: ChainConfig = {
  numeraire: 'USD',
  currencies: RISK_CURRENCIES as readonly Currency[],
  tokens: TOKENS,
  decimals: 6,
  slippageBps: 30,
  validitySec: 3600,
};

const costs = {
  gammaFixed: 0.02,
  spreadBps: 2,
  etaImpact: 0.002,
  depth: 5_000_000,
  carryRate: 0.06 / 365 / 96,
  kappa: 0.1,
  esPerUnit: 0.001,
  breachCost: 50_000,
};

function input(over: Partial<HandlerInput> = {}, balances?: Record<string, number>): HandlerInput {
  const bands = { lower: 400_000, target: 600_000, upper: 900_000 };
  return {
    treasury: {
      epoch: 100,
      nonce: 1,
      balances: balances ?? { USD: 20_000_000, EUR: 600_000, GBP: 600_000, BRL: 600_000 },
      commitments: [],
      policyVersion: 3,
      bandParamsHash: `0x${'11'.repeat(32)}`,
      bands: { EUR: bands, GBP: bands, BRL: bands },
      limits: {
        EUR: { costs, maxSingleOrder: 5_000_000, settlementDays: 1 / 96 },
        GBP: { costs, maxSingleOrder: 5_000_000, settlementDays: 1 / 96 },
        BRL: { costs, maxSingleOrder: 5_000_000, settlementDays: 2 },
      },
      risk: {
        horizonDays: 1 / 96,
        alpha: 0.975,
        basisHaircutBps: 50,
        lotSize: 10_000,
        minOrder: 20_000,
        autoApproveThreshold: 1_000_000,
        maxPerEpoch: 10_000_000,
        fundingFloor: 1_000_000,
        maxStalenessSec: 600,
      },
    },
    market: {
      timestamp: NOW - 5_000,
      currentVol,
      residuals,
      rates: { EUR: 0.92, GBP: 0.79, BRL: 5.4 },
      gasUsdc: 0.02,
    },
    chain: CHAIN,
    saltSeed: 'test-seed',
    now: NOW,
    ...over,
  };
}

describe('commitment salt', () => {
  /**
   * The handler is a pure function: no randomness. Yet the salt must be unpredictable to
   * an observer, otherwise the space of quantised plans can be walked by brute force and
   * the commitment hides nothing. Deriving it from a secret reconciles both requirements.
   */
  test('deterministic for identical seed, epoch and nonce', () => {
    assert.equal(deriveSalt('s', 100, 1), deriveSalt('s', 100, 1));
  });

  test('no salt is reused across reports', () => {
    const seen = new Set([
      deriveSalt('s', 100, 1),
      deriveSalt('s', 100, 2),
      deriveSalt('s', 101, 1),
    ]);
    assert.equal(seen.size, 3);
  });

  test('a different seed gives a different salt', () => {
    assert.notEqual(deriveSalt('a', 100, 1), deriveSalt('b', 100, 1));
  });
});

describe('report', () => {
  test('no order while inside the bands', () => {
    const out = buildReport(input());
    assert.equal(out.status, 'NOOP');
    assert.equal(out.reveal.orders.length, 0);
  });

  test('a balance below the lower threshold produces a buy', () => {
    const out = buildReport(input({}, { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 }));
    assert.equal(out.status, 'PROPOSE');
    assert.equal(out.reveal.orders.length, 1);
    assert.equal(out.reveal.orders[0]!.sell, TOKENS.USD);
    assert.equal(out.reveal.orders[0]!.buy, TOKENS.EUR);
  });

  /**
   * The notional must be computed exactly the way the vault recomputes it — incoming
   * amount for a buy, minimum outgoing amount for a sell. Any other convention would make
   * execution fail on `NotionalMismatch`, after a valid signature and a human approval.
   */
  test('the notional follows the vault rule', () => {
    const out = buildReport(
      input({}, { USD: 20_000_000, EUR: 100_000, GBP: 2_000_000, BRL: 600_000 }),
    );
    const expected = out.reveal.orders.reduce(
      (a, o) => a + (o.sell === TOKENS.USD ? o.amountIn : o.minAmountOut),
      0n,
    );
    assert.equal(out.report.grossNotional, expected);
    assert.ok(out.reveal.orders.some((o) => o.sell === TOKENS.USD), 'no buy');
    assert.ok(out.reveal.orders.some((o) => o.buy === TOKENS.USD), 'no sell');
  });

  test('amounts are converted into token units through the rate', () => {
    const out = buildReport(input({}, { USD: 20_000_000, EUR: 600_000, GBP: 600_000, BRL: 3_000_000 }));
    const sale = out.reveal.orders.find((o) => o.sell === TOKENS.BRL);
    assert.ok(sale, 'the BRL sale is missing');
    // Selling a BRL excess: the amount given up is denominated in BRL, hence multiplied
    // by the rate, while the expected proceeds stay in numeraire.
    assert.ok(sale!.amountIn > sale!.minAmountOut * 4n, 'rate conversion not applied');
  });

  test('the slippage tolerance lowers the minimum expected amount', () => {
    const tight = buildReport(
      input({ chain: { ...CHAIN, slippageBps: 0 } }, { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 }),
    );
    const loose = buildReport(
      input({ chain: { ...CHAIN, slippageBps: 500 } }, { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 }),
    );
    assert.ok(loose.reveal.orders[0]!.minAmountOut < tight.reveal.orders[0]!.minAmountOut);
  });

  test('the commitment depends on the plan and the salt', () => {
    const a = buildReport(input({}, { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 }));
    const b = buildReport(
      input({ saltSeed: 'other' }, { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 }),
    );
    assert.notEqual(a.report.ordersCommitment, b.report.ordersCommitment);
  });

  test('the report envelope is consistent', () => {
    const out = buildReport(input());
    assert.equal(out.report.epoch, 100n);
    assert.equal(out.report.policyVersion, 3n);
    assert.ok(out.report.expiry > BigInt(Math.floor(NOW / 1000)));
    assert.ok(out.report.inputsTimestamp <= BigInt(Math.floor(NOW / 1000)));
  });

  /** No per-currency amount may appear in what is published (D6). */
  test('the published report contains no per-currency amount', () => {
    const out = buildReport(input({}, { USD: 20_000_000, EUR: 100_000, GBP: 2_000_000, BRL: 600_000 }));
    const serialised = JSON.stringify(out.report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (const o of out.reveal.orders) {
      assert.ok(!serialised.includes(o.amountIn.toString()), 'an order amount leaked');
    }
  });

  test('stale market data causes the decision to be rejected', () => {
    const out = buildReport(input({ market: { ...input().market, timestamp: NOW - 3_600_000 } }));
    assert.equal(out.status, 'REJECTED');
    assert.equal(out.reveal.orders.length, 0);
  });

  test('the result is deterministic — the handler is a pure function', () => {
    const i = input({}, { USD: 20_000_000, EUR: 100_000, GBP: 600_000, BRL: 600_000 });
    assert.deepEqual(buildReport(i), buildReport(i));
  });

  test('a missing rate is reported rather than silently worked around', () => {
    assert.throws(
      () =>
        buildReport(
          input({ market: { ...input().market, rates: { EUR: 0.92 } } }, { USD: 20_000_000, EUR: 600_000, GBP: 100_000, BRL: 600_000 }),
        ),
      RangeError,
    );
  });
});
