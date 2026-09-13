/**
 * Simulation-based evaluation of a band policy, and the objective function J.
 *
 * J = E[ Σ_t ( r·B_t              carry cost
 *             + γ·1{rebalance}    fixed cost
 *             + variable cost     spread + impact
 *             + κ·ES(B_t)         FX risk cost
 *             + c_b·1{B_t < 0} ) ] breach cost
 *
 * This is the system's **only** decision rule (SPEC §4.1). The bands are not an input of
 * the model but the result of minimising J: the Miller-Orr band is the special case you
 * recover once the risk and breach terms are zeroed out and flows are assumed driftless.
 */

import { Rng } from '../../../data/src/random.ts';
import type { Bands } from './millerOrr.ts';
import type { TailModel } from './tail.ts';

export interface CostParams {
  /** Fixed cost per rebalance. */
  readonly gammaFixed: number;
  /** Proportional variable cost, in basis points. */
  readonly spreadBps: number;
  /** Impact coefficient — UNCALIBRATED, exposed as a parameter (SPEC §4.6). */
  readonly etaImpact: number;
  /** Reference depth for square-root impact. */
  readonly depth: number;
  /** Carry cost per period. */
  readonly carryRate: number;
  /** Risk aversion. */
  readonly kappa: number;
  /** ES per unit of exposure over a one-period horizon. */
  readonly esPerUnit: number;
  /**
   * Cost of a balance breach. Strongly asymmetric: service penalty plus emergency
   * funding. This term, and this term alone, is what justifies holding a buffer at all —
   * without it the optimum would be a zero balance.
   *
   * It is charged **in expectation** — cost × P(flow < −balance) — rather than by
   * counting observed breaches: see the resolution problem laid out in `tail.ts`.
   */
  readonly breachCost: number;
}

/** Execution cost of an order of size `q`: proportional spread + square-root impact. */
export function executionCost(q: number, p: CostParams): number {
  const size = Math.abs(q);
  if (size === 0) return 0;
  const spread = (p.spreadBps / 10_000) * size;
  const impact = p.depth > 0 ? p.etaImpact * size * Math.sqrt(size / p.depth) : 0;
  return spread + impact;
}

export interface PolicyOutcome {
  /** Average total cost per path. */
  readonly cost: number;
  readonly carry: number;
  readonly fixed: number;
  readonly variable: number;
  readonly risk: number;
  readonly breach: number;
  /** Average number of rebalances per path. */
  readonly rebalances: number;
  /** Average number of breaches actually *observed* — diagnostic, not priced. */
  readonly breaches: number;
  /** Average per-period breach probability, as priced. */
  readonly breachProbability: number;
  /** Average balance carried — the idle capital metric. */
  readonly avgBalance: number;
}

/**
 * Evaluates a band policy on a set of net flow paths.
 *
 * The paths are supplied by the caller and **reused identically** across every candidate
 * in the search: this is the common random numbers technique. Without it, the optimiser
 * compares candidates evaluated on different draws and chases simulation noise rather
 * than the minimum.
 */
export function evaluatePolicy(
  bands: Bands,
  paths: readonly (readonly number[])[],
  p: CostParams,
  tail: TailModel,
): PolicyOutcome {
  let carry = 0;
  let fixed = 0;
  let variable = 0;
  let risk = 0;
  let breach = 0;
  let rebalances = 0;
  let breaches = 0;
  let breachProbAcc = 0;
  let balanceAcc = 0;
  let steps = 0;

  for (const path of paths) {
    let b = bands.target;
    for (const flow of path) {
      // Breach risk is priced on the balance *before* the shock: that is the
      // information the engine actually has at decision time.
      const pBreach = tail.probBelow(-b);
      breach += p.breachCost * pBreach;
      breachProbAcc += pBreach;

      b += flow;
      if (b < 0) breaches++;

      carry += p.carryRate * Math.max(b, 0);
      risk += p.kappa * p.esPerUnit * Math.abs(b);
      balanceAcc += b;
      steps++;

      if (b < bands.lower || b > bands.upper) {
        const q = bands.target - b;
        fixed += p.gammaFixed;
        variable += executionCost(q, p);
        rebalances++;
        b = bands.target;
      }
    }
  }

  const m = paths.length;
  return {
    cost: (carry + fixed + variable + risk + breach) / m,
    carry: carry / m,
    fixed: fixed / m,
    variable: variable / m,
    risk: risk / m,
    breach: breach / m,
    rebalances: rebalances / m,
    breaches: breaches / m,
    breachProbability: steps > 0 ? breachProbAcc / steps : 0,
    avgBalance: steps > 0 ? balanceAcc / steps : 0,
  };
}

/**
 * Bootstrap resampling of historical net flows.
 *
 * Independent draws with replacement: preserves the marginal distribution of net flows —
 * hence the fat tails inherited from log-normal amounts — but destroys their
 * autocorrelation. An accepted limitation: a block bootstrap would keep the temporal
 * dependence, at the price of a block-length parameter to calibrate.
 */
export function bootstrapPaths(
  history: readonly number[],
  pathCount: number,
  pathLength: number,
  seed: number,
): number[][] {
  if (history.length === 0) throw new RangeError('empty history');
  const rng = new Rng(seed);
  const paths: number[][] = [];
  for (let m = 0; m < pathCount; m++) {
    const path = new Array<number>(pathLength);
    for (let t = 0; t < pathLength; t++) {
      path[t] = history[rng.nextU32() % history.length]!;
    }
    paths.push(path);
  }
  return paths;
}
