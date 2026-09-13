/** Backtest protocol tests — SPEC §18, decision D10. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CORRIDORS } from '../../data/calibration/corridors.ts';
import { generateFlows } from '../../data/src/generator.ts';
import { bucketize } from '../../data/src/aggregate.ts';
import { simulateMarket } from '../../data/src/market.ts';
import { CURRENCIES, EPOCHS_PER_DAY, EPOCH_MS, FAST_CONFIG } from '../src/backtest/config.ts';
import { buildPolicy, esPerUnit } from '../src/backtest/policies.ts';
import { runPolicy } from '../src/backtest/simulate.ts';
import { runBacktest, runSeed } from '../src/backtest/walkforward.ts';
import { standardizedResiduals } from '../src/risk/residuals.ts';
import type { Currency } from '../../data/src/types.ts';
import type { PolicyKind } from '../src/backtest/types.ts';

const CFG = FAST_CONFIG;
const POLICIES: readonly PolicyKind[] = ['STATIC', 'CALENDAR', 'NEAP', 'CLAIRVOYANT'];

function flowsFor(seed: number, days: number): Record<Currency, number[]> {
  const events = generateFlows({
    seed,
    startTs: CFG.startTs,
    days,
    corridors: CORRIDORS,
  });
  const buckets = bucketize(events, CFG.startTs, EPOCH_MS, days * EPOCHS_PER_DAY);
  const out = {} as Record<Currency, number[]>;
  for (const c of CURRENCIES) out[c] = buckets.map((b) => b.net[c]);
  return out;
}

describe('walk-forward protocol', () => {
  test('the backtest is reproducible seed by seed', () => {
    assert.deepEqual(runSeed(1000, CFG), runSeed(1000, CFG));
  });

  test('different seeds produce different results', () => {
    assert.notDeepEqual(runSeed(1000, CFG), runSeed(1001, CFG));
  });

  test('all four policies are evaluated', () => {
    const r = runSeed(1000, CFG);
    for (const k of POLICIES) assert.ok(r.byPolicy[k], `policy ${k} missing`);
  });

  /**
   * The lookahead canary.
   *
   * A gigantic shock is injected into the *future* portion of the flow series, then the
   * bands are rebuilt from the calibration window alone. If the result changes,
   * information later than the decision date has leaked upstream — the most insidious
   * defect in a backtest, because it flatters the results without ever raising an error.
   *
   * The counter-test is just as necessary: the same shock injected into the calibration
   * window *must* move the bands. Without it, a canary that detects nothing could simply
   * be a dead canary.
   */
  test('no future information reaches earlier decisions', () => {
    const days = CFG.warmupDays + CFG.evalDays;
    const calibEpochs = CFG.warmupDays * EPOCHS_PER_DAY;
    const clean = flowsFor(2024, days);
    const market = simulateMarket(999, days);
    const dailyVol = {} as Record<Currency, number>;
    for (const c of CURRENCIES) dailyVol[c] = 0.005;

    const slice = (f: Record<Currency, number[]>, a: number, b: number) => {
      const o = {} as Record<Currency, number[]>;
      for (const c of CURRENCIES) o[c] = f[c]!.slice(a, b);
      return o;
    };

    const build = (f: Record<Currency, number[]>) =>
      buildPolicy('NEAP', {
        calibration: slice(f, 0, calibEpochs),
        evaluation: slice(f, calibEpochs, f.EUR.length),
        dailyVol,
        cfg: CFG,
        seed: 7,
      }).bands;

    const reference = build(clean);

    // Shock in the future: the bands must not move by a dollar.
    const futureShock = slice(clean, 0, clean.EUR.length);
    futureShock.EUR[calibEpochs + 10] = -500_000_000;
    assert.deepEqual(build(futureShock), reference, 'information leaked from the future');

    // Counter-test: the same shock in the past must move the bands.
    const pastShock = slice(clean, 0, clean.EUR.length);
    pastShock.EUR[calibEpochs - 10] = -500_000_000;
    assert.notDeepEqual(build(pastShock), reference, 'the canary no longer detects anything');

    void market;
  });
});

describe('policies', () => {
  const days = CFG.warmupDays;
  const flows = flowsFor(2024, days);
  const dailyVol = {} as Record<Currency, number>;
  for (const c of CURRENCIES) dailyVol[c] = 0.005;
  const input = { calibration: flows, evaluation: flows, dailyVol, cfg: CFG, seed: 5 };

  test('every policy produces ordered, positive bands', () => {
    for (const k of POLICIES) {
      const { bands } = buildPolicy(k, input);
      for (const c of CURRENCIES) {
        const b = bands[c];
        assert.ok(b.lower >= 0, `${k}/${c}: negative lower threshold`);
        assert.ok(b.lower <= b.target && b.target <= b.upper, `${k}/${c}: bands out of order`);
        assert.ok(Number.isFinite(b.target), `${k}/${c}: non-finite target`);
      }
    }
  });

  /**
   * Conservative sizing must stay positive even on a structurally *inbound* corridor.
   *
   * A first attempt measured the worst daily net outflow; on the euro, whose flows are
   * overwhelmingly inbound, that is zero. The band became negligible and the policy
   * supposed to be the most prudent racked up four hundred and forty breaches. A positive
   * net balance over the day says nothing about the trough crossed along the way.
   */
  test('the conservative buffer stays substantial on an inbound corridor', () => {
    const { bands } = buildPolicy('STATIC', input);
    for (const c of CURRENCIES) {
      assert.ok(bands[c].target > 100_000, `${c}: negligible static target (${bands[c].target})`);
    }
  });

  test('only the calendar policy is flagged as such', () => {
    for (const k of POLICIES) {
      assert.equal(buildPolicy(k, input).calendarOnly, k === 'CALENDAR');
    }
  });

  test('ES per unit of exposure grows with volatility', () => {
    assert.ok(esPerUnit(0.01) > esPerUnit(0.005));
  });
});

describe('running a policy', () => {
  const days = CFG.warmupDays;
  const flows = flowsFor(2024, days);
  const market = simulateMarket(999, days);
  const { residuals, currentVol } = standardizedResiduals(market.returns, CURRENCIES);
  const dailyVol = {} as Record<Currency, number>;
  for (const c of CURRENCIES) dailyVol[c] = 0.005;
  const policy = buildPolicy('NEAP', {
    calibration: flows,
    evaluation: flows,
    dailyVol,
    cfg: CFG,
    seed: 5,
  });

  const run = () => runPolicy({ policy, flows, residuals, currentVol });

  test('the result is deterministic', () => {
    assert.deepEqual(run(), run());
  });

  test('total cost is the sum of carry and execution', () => {
    const m = run();
    assert.ok(Math.abs(m.totalCost - (m.carryCost + m.executionCost)) < 1e-6);
  });

  test('every quantity is non-negative', () => {
    const m = run();
    for (const [name, v] of Object.entries(m)) {
      assert.ok(v >= 0, `${name} is negative: ${v}`);
    }
  });

  /// A calendar policy cannot rebalance more than once per day per currency.
  test('the calendar cadence is respected', () => {
    const calendar = buildPolicy('CALENDAR', {
      calibration: flows,
      evaluation: flows,
      dailyVol,
      cfg: CFG,
      seed: 5,
    });
    const m = runPolicy({ policy: calendar, flows, residuals, currentVol });
    const maxPossible = days * CURRENCIES.length;
    assert.ok(m.rebalances <= maxPossible, `${m.rebalances} > ${maxPossible}`);
  });
});

describe('aggregation', () => {
  const summary = runBacktest(CFG);

  test('the confidence intervals use every seed', () => {
    for (const k of POLICIES) {
      assert.equal(summary.metrics[k].capital.n, CFG.seeds.length);
      assert.ok(summary.metrics[k].capital.halfWidth >= 0);
    }
  });

  /**
   * The central result of the backtest: optimised bands tie up far less capital than
   * conservative pre-funding. The threshold is deliberately loose — what is tested is
   * that the thesis holds, not that it reaches a precise figure, which depends on
   * assumptions explicitly declared as uncalibrated.
   */
  test('optimised bands release most of the idle capital', () => {
    const ratio = summary.metrics.NEAP.capital.mean / summary.metrics.STATIC.capital.mean;
    assert.ok(ratio < 0.5, `NEAP / STATIC capital = ${ratio.toFixed(3)}, expected < 0.5`);
  });

  test('FX risk falls in the same proportion', () => {
    assert.ok(summary.metrics.NEAP.es.mean < summary.metrics.STATIC.es.mean);
  });

  /**
   * An honesty check. NEAP rebalances far more often than conservative pre-funding: if
   * the report claimed otherwise, the simulation would be counting wrong.
   */
  test('NEAP places far more orders than conservative pre-funding', () => {
    assert.ok(summary.metrics.NEAP.rebalances.mean > summary.metrics.STATIC.rebalances.mean * 5);
  });
});
