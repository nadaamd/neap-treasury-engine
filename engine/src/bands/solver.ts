/**
 * Numerical band solving — decision D3.
 *
 * Pattern search over the triple (lower, target, upper), warm-started from the
 * Miller-Orr closed form and evaluated by simulation on paths shared by every candidate.
 *
 * Why pattern search rather than a gradient: the objective is evaluated by simulation,
 * so it is noisy and non-differentiable. A numerical gradient would be dominated by that
 * noise. Pattern search assumes nothing beyond the ability to evaluate J, and its
 * stopping criterion — the step falls below the tolerance — is readable in currency
 * units.
 *
 * Why the Miller-Orr warm start: it places the starting point in the right order of
 * magnitude. Without it, the search would start from an arbitrary point and spend most
 * of its evaluation budget just crossing the space.
 */

import { millerOrrBands } from './millerOrr.ts';
import type { Bands, MillerOrrInput } from './millerOrr.ts';
import { evaluatePolicy } from './simulate.ts';
import type { CostParams, PolicyOutcome } from './simulate.ts';
import type { TailModel } from './tail.ts';

export interface SolveOptions {
  readonly paths: readonly (readonly number[])[];
  readonly costs: CostParams;
  /** Tail model used to price breach risk in expectation. */
  readonly tail: TailModel;
  readonly warmStart: Bands;
  /** Operational floor: the lower threshold cannot go below it. */
  readonly floor: number;
  /** Initial search step, in currency. */
  readonly initialStep: number;
  /** Stop once the step falls below this threshold. */
  readonly tolerance: number;
  readonly maxEvaluations: number;
}

export interface SolveResult {
  readonly bands: Bands;
  readonly outcome: PolicyOutcome;
  readonly warmStartOutcome: PolicyOutcome;
  readonly evaluations: number;
  readonly finalStep: number;
}

/** Projects a candidate triple onto the feasible set: floor ≤ lower ≤ target ≤ upper. */
function project(b: Bands, floor: number): Bands {
  const lower = Math.max(floor, b.lower);
  const target = Math.max(lower, b.target);
  const upper = Math.max(target, b.upper);
  return { lower, target, upper };
}

export function solveBands(o: SolveOptions): SolveResult {
  const { paths, costs, tail, floor, tolerance, maxEvaluations } = o;
  let evaluations = 0;

  const evaluate = (b: Bands): PolicyOutcome => {
    evaluations++;
    return evaluatePolicy(b, paths, costs, tail);
  };

  const warmStart = project(o.warmStart, floor);
  const warmStartOutcome = evaluate(warmStart);

  let best = warmStart;
  let bestOutcome = warmStartOutcome;
  let step = o.initialStep;

  while (step > tolerance && evaluations < maxEvaluations) {
    let improved = false;

    for (const axis of ['lower', 'target', 'upper'] as const) {
      for (const sign of [1, -1]) {
        if (evaluations >= maxEvaluations) break;
        const candidate = project({ ...best, [axis]: best[axis] + sign * step }, floor);
        // Projection can map the candidate back onto the current point: no need to evaluate.
        if (
          candidate.lower === best.lower &&
          candidate.target === best.target &&
          candidate.upper === best.upper
        ) {
          continue;
        }
        const outcome = evaluate(candidate);
        if (outcome.cost < bestOutcome.cost) {
          best = candidate;
          bestOutcome = outcome;
          improved = true;
        }
      }
    }

    // No neighbour does better: refine the mesh.
    if (!improved) step /= 2;
  }

  return { bands: best, outcome: bestOutcome, warmStartOutcome, evaluations, finalStep: step };
}

/** Full chain: analytic warm-start bands, then numerical refinement. */
export function solveBandsFromScratch(
  millerOrr: MillerOrrInput,
  paths: readonly (readonly number[])[],
  costs: CostParams,
  tail: TailModel,
  overrides: Partial<Pick<SolveOptions, 'initialStep' | 'tolerance' | 'maxEvaluations'>> = {},
): SolveResult {
  const warmStart = millerOrrBands(millerOrr);
  const scale = Math.max(warmStart.target - warmStart.lower, 1);
  return solveBands({
    paths,
    costs,
    tail,
    warmStart,
    floor: millerOrr.lower,
    initialStep: overrides.initialStep ?? scale / 2,
    tolerance: overrides.tolerance ?? scale / 512,
    maxEvaluations: overrides.maxEvaluations ?? 4000,
  });
}
