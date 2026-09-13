/** Band solver tests — SPEC §4.1 and §4.2, decision D3. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CORRIDORS } from '../../data/calibration/corridors.ts';
import { generateFlows } from '../../data/src/generator.ts';
import { bucketize } from '../../data/src/aggregate.ts';
import { mean, stdev } from '../../data/src/stats.ts';
import { millerOrrBands } from '../src/bands/millerOrr.ts';
import { bootstrapPaths, evaluatePolicy, executionCost } from '../src/bands/simulate.ts';
import { empiricalLeftTail } from '../src/bands/tail.ts';
import type { CostParams } from '../src/bands/simulate.ts';
import { solveBands } from '../src/bands/solver.ts';

const START = Date.UTC(2025, 0, 1);
const EPOCH_MS = 15 * 60 * 1000;
const EPOCHS_PER_DAY = 96;
const DAYS = 180;

const events = generateFlows({ seed: 7, startTs: START, days: DAYS, corridors: CORRIDORS });
const rawFlows = bucketize(events, START, EPOCH_MS, DAYS * EPOCHS_PER_DAY).map((b) => b.net.EUR);
const drift = mean(rawFlows);
/** Driftless series: this is Miller-Orr's assumption set. */
const flatFlows = rawFlows.map((x) => x - drift);
const FLOW_SIGMA = stdev(flatFlows);
const CARRY = 0.06 / 365 / EPOCHS_PER_DAY;

const PATHS = bootstrapPaths(flatFlows, 300, 400, 99);
const TAIL = empiricalLeftTail(flatFlows);
const DRIFTED_PATHS = bootstrapPaths(rawFlows, 300, 400, 99);

const baseCosts: CostParams = {
  gammaFixed: 2,
  spreadBps: 0,
  etaImpact: 0,
  depth: 5_000_000,
  carryRate: CARRY,
  kappa: 0,
  esPerUnit: 0,
  breachCost: 50_000,
};

function solve(costs: Partial<CostParams>, paths = PATHS) {
  const merged = { ...baseCosts, ...costs };
  const mo = millerOrrBands({
    gammaFixed: merged.gammaFixed,
    flowSigma: FLOW_SIGMA,
    carryRate: merged.carryRate,
    lower: 0,
  });
  const spread = mo.target - mo.lower;
  return {
    analytic: mo,
    result: solveBands({
      paths,
      costs: merged,
      tail: TAIL,
      warmStart: mo,
      floor: 0,
      initialStep: spread / 2,
      tolerance: spread / 512,
      maxEvaluations: 8000,
    }),
  };
}

describe('analytic Miller-Orr', () => {
  const mo = millerOrrBands({ gammaFixed: 25, flowSigma: FLOW_SIGMA, carryRate: CARRY, lower: 0 });

  test('the identity H = 3Z − 2L holds', () => {
    assert.ok(Math.abs(mo.upper - (3 * mo.target - 2 * mo.lower)) < 1e-6);
  });

  test('the floor is respected and the band ordering is consistent', () => {
    const withFloor = millerOrrBands({
      gammaFixed: 25,
      flowSigma: FLOW_SIGMA,
      carryRate: CARRY,
      lower: 500_000,
    });
    assert.equal(withFloor.lower, 500_000);
    assert.ok(withFloor.lower < withFloor.target && withFloor.target < withFloor.upper);
  });

  /**
   * THE property of the project (SPEC §1.2).
   *
   * Band width grows as γ^(1/3). Moving from a correspondent-bank rail to stablecoin
   * settlement divides the fixed cost by 10⁴, hence the band by 10⁴^(1/3) ≈ 21.5. That is
   * the buffer collapse the backtest has to quantify.
   */
  test('band width follows the γ^(1/3) law exactly', () => {
    const slow = millerOrrBands({ gammaFixed: 25, flowSigma: FLOW_SIGMA, carryRate: CARRY, lower: 0 });
    const fast = millerOrrBands({ gammaFixed: 0.0025, flowSigma: FLOW_SIGMA, carryRate: CARRY, lower: 0 });
    const ratio = (slow.upper - slow.lower) / (fast.upper - fast.lower);
    assert.ok(Math.abs(ratio - Math.cbrt(10_000)) < 0.01, `factor ${ratio.toFixed(3)} ≠ 21.544`);
  });

  test('degenerate inputs are rejected', () => {
    assert.throws(() => millerOrrBands({ gammaFixed: 1, flowSigma: 0, carryRate: CARRY, lower: 0 }), RangeError);
    assert.throws(() => millerOrrBands({ gammaFixed: 1, flowSigma: 1, carryRate: 0, lower: 0 }), RangeError);
  });
});

describe('numerical solver — validated against the closed form (D3)', () => {
  /**
   * The solver is not supposed to *equal* Miller-Orr: it solves a strictly richer problem
   * (discrete time, breach cost, possible drift). What is checked is that it reproduces
   * its **structure** where the analytic assumptions approximately hold, that is, when
   * the band is wide relative to the one-period flow shock.
   */
  test('numerical width tracks the analytic one inside the valid regime', () => {
    for (const gammaFixed of [2, 25, 250]) {
      const { analytic, result } = solve({ gammaFixed });
      const wA = analytic.upper - analytic.lower;
      const wN = result.bands.upper - result.bands.lower;
      assert.ok(
        wN / wA > 0.7 && wN / wA < 1.5,
        `γ=${gammaFixed}: numerical/analytic width = ${(wN / wA).toFixed(2)}`,
      );
    }
  });

  test('the numerical scaling exponent stays close to the cube root', () => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const gammaFixed of [0.2, 2, 25, 250]) {
      const { result } = solve({ gammaFixed });
      xs.push(Math.log(gammaFixed));
      ys.push(Math.log(result.bands.upper - result.bands.lower));
    }
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      den += (xs[i]! - mx) ** 2;
    }
    const slope = num / den;
    assert.ok(slope > 0.25 && slope < 0.6, `exponent ${slope.toFixed(3)} outside [0.25, 0.60]`);
  });

  /**
   * The validity condition of the band model, discovered while calibrating the solver.
   *
   * Miller-Orr is a continuous-time result: it assumes the balance drifts slowly until it
   * touches a boundary. If the one-period flow shock exceeds the band width, the balance
   * jumps over the boundaries at every step and the policy degenerates into "rebalance
   * every period".
   *
   * That is what happens at daily granularity: one day of flow moves the EUR balance by
   * ±$1.5M while the optimal band on a fast rail is $100k. At fifteen minutes the shock
   * falls to ~$70k and the model becomes applicable again — which **quantitatively
   * justifies** the spec's epoch choice instead of settling it by convention.
   */
  test('outside the valid regime, the policy degenerates into permanent rebalancing', () => {
    const { result } = solve({ gammaFixed: 0.02 });
    const pathLength = PATHS[0]!.length;
    const rate = result.outcome.rebalances / pathLength;
    assert.ok(rate > 0.5, `rebalancing rate ${rate.toFixed(2)}: the expected degeneracy does not appear`);
    assert.ok(
      result.bands.upper - result.bands.lower < FLOW_SIGMA,
      'the band should be narrower than the flow shock in this regime',
    );
  });
});

describe('solver properties', () => {
  test('the result is never worse than the warm start', () => {
    const { result } = solve({});
    assert.ok(result.outcome.cost <= result.warmStartOutcome.cost);
  });

  test('determinism: same paths and same costs ⇒ same bands', () => {
    const a = solve({}).result.bands;
    const b = solve({}).result.bands;
    assert.deepEqual(a, b);
  });

  test('common random numbers make the evaluation reproducible', () => {
    const bands = { lower: 100_000, target: 400_000, upper: 900_000 };
    const one = evaluatePolicy(bands, PATHS, baseCosts, TAIL);
    const two = evaluatePolicy(bands, PATHS, baseCosts, TAIL);
    assert.deepEqual(one, two);
  });

  test('the operational floor is respected', () => {
    const mo = millerOrrBands({ gammaFixed: 2, flowSigma: FLOW_SIGMA, carryRate: CARRY, lower: 250_000 });
    const r = solveBands({
      paths: PATHS,
      costs: baseCosts,
      tail: TAIL,
      warmStart: mo,
      floor: 250_000,
      initialStep: 100_000,
      tolerance: 1_000,
      maxEvaluations: 4000,
    });
    assert.ok(r.bands.lower >= 250_000);
    assert.ok(r.bands.lower <= r.bands.target && r.bands.target <= r.bands.upper);
  });
});

describe('comparative statics — the economics of the model', () => {
  const targetOf = (c: Partial<CostParams>, paths = PATHS) => solve(c, paths).result.bands.target;

  test('a higher breach cost raises the buffer', () => {
    assert.ok(targetOf({ breachCost: 500_000 }) > targetOf({ breachCost: 20_000 }));
  });

  /**
   * Validating the optimiser through the first-order condition.
   *
   * At the optimum, the marginal carry cost of one extra dollar of buffer equals the
   * marginal reduction in expected breach cost. Since carry does not depend on the breach
   * cost, the optimal breach probability must scale as **1/c_b**: multiplying it by ten
   * must divide the probability by ten.
   *
   * This is the most demanding test of the solver — it checks not a value but a
   * *relation* that only a correct optimisation can produce.
   */
  test('the optimal breach probability scales as 1/breach cost', () => {
    const products: number[] = [];
    for (const breachCost of [5_000, 50_000, 500_000, 5_000_000]) {
      const { result } = solve({ breachCost });
      products.push(breachCost * result.outcome.breachProbability);
    }
    const lo = Math.min(...products);
    const hi = Math.max(...products);
    assert.ok(
      hi / lo < 3,
      `c_b × P* should stay near constant; observed ${products.map((x) => x.toFixed(3)).join(', ')}`,
    );
  });

  test('the priced breach probability stays strictly positive', () => {
    const { result } = solve({});
    assert.ok(result.outcome.breachProbability > 0, 'the breach term must stay active');
    assert.ok(result.outcome.breachProbability < 1e-3, 'implausible probability at the optimum');
  });

  test('a higher carry cost lowers the buffer', () => {
    assert.ok(targetOf({ carryRate: CARRY * 8 }) < targetOf({ carryRate: CARRY }));
  });

  test('stronger risk aversion lowers the buffer', () => {
    const neutral = targetOf({ kappa: 0, esPerUnit: 0.001 });
    const averse = targetOf({ kappa: 2, esPerUnit: 0.001 });
    assert.ok(averse < neutral, `averse ${averse.toFixed(0)} should sit below neutral ${neutral.toFixed(0)}`);
  });

  test('a positive flow drift reduces the required buffer', () => {
    assert.ok(targetOf({}, DRIFTED_PATHS) < targetOf({}, PATHS));
  });
});

describe('execution cost', () => {
  test('zero for a zero order, symmetric in sign', () => {
    assert.equal(executionCost(0, baseCosts), 0);
    const p = { ...baseCosts, spreadBps: 5, etaImpact: 0.1 };
    assert.equal(executionCost(1_000, p), executionCost(-1_000, p));
  });

  test('impact is convex: doubling the size more than doubles the impact cost', () => {
    const p = { ...baseCosts, spreadBps: 0, etaImpact: 0.1 };
    assert.ok(executionCost(2_000, p) > 2 * executionCost(1_000, p));
  });
});
