/**
 * Résolution numérique des bandes — décision D3.
 *
 * Recherche par motif (pattern search) sur le triplet (bas, cible, haut), amorcée par la
 * solution analytique de Miller-Orr et évaluée par simulation sur des trajectoires
 * communes à tous les candidats.
 *
 * Pourquoi une recherche par motif plutôt qu'un gradient : la fonction objectif est
 * évaluée par simulation, donc bruitée et non différentiable. Un gradient numérique y
 * serait dominé par le bruit. La recherche par motif ne suppose rien d'autre que la
 * possibilité d'évaluer J, et son critère d'arrêt — le pas devient plus petit que la
 * tolérance — est interprétable en unités monétaires.
 *
 * Pourquoi l'amorçage par Miller-Orr : il place le point de départ dans le bon ordre de
 * grandeur. Sans lui, la recherche partirait d'un point arbitraire et consommerait
 * l'essentiel de son budget d'évaluations à traverser l'espace.
 */

import { millerOrrBands } from './millerOrr.ts';
import type { Bands, MillerOrrInput } from './millerOrr.ts';
import { evaluatePolicy } from './simulate.ts';
import type { CostParams, PolicyOutcome } from './simulate.ts';
import type { TailModel } from './tail.ts';

export interface SolveOptions {
  readonly paths: readonly (readonly number[])[];
  readonly costs: CostParams;
  /** Modèle de queue servant à tarifer le risque de rupture en espérance. */
  readonly tail: TailModel;
  readonly warmStart: Bands;
  /** Plancher opérationnel : le seuil bas ne peut pas descendre en dessous. */
  readonly floor: number;
  /** Pas initial de la recherche, en monnaie. */
  readonly initialStep: number;
  /** Arrêt lorsque le pas passe sous ce seuil. */
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

/** Projette un triplet candidat sur le domaine admissible : floor ≤ bas ≤ cible ≤ haut. */
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
        // La projection peut ramener le candidat sur le point courant : inutile de l'évaluer.
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

    // Aucun voisin ne fait mieux : on raffine la maille.
    if (!improved) step /= 2;
  }

  return { bands: best, outcome: bestOutcome, warmStartOutcome, evaluations, finalStep: step };
}

/** Chaîne complète : bandes analytiques d'amorçage, puis raffinement numérique. */
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
