/**
 * Évaluation d'une politique de bandes par simulation, et fonction objectif J.
 *
 * J = E[ Σ_t ( r·B_t                coût de portage
 *             + γ·1{rééquilibrage}  coût fixe
 *             + coût variable       spread + impact
 *             + κ·ES(B_t)           coût du risque de change
 *             + c_b·1{B_t < 0} ) ]  coût de rupture
 *
 * C'est la **seule** règle de décision du système (SPEC §4.1). Les bandes ne sont pas
 * une entrée du modèle mais le résultat de la minimisation de J : la bande de Miller-Orr
 * est le cas particulier qu'on retrouve quand on annule les termes de risque et de
 * rupture et qu'on suppose les flux sans dérive.
 */

import { Rng } from '../../../data/src/random.ts';
import type { Bands } from './millerOrr.ts';
import type { TailModel } from './tail.ts';

export interface CostParams {
  /** Coût fixe par rééquilibrage. */
  readonly gammaFixed: number;
  /** Coût variable proportionnel, en points de base. */
  readonly spreadBps: number;
  /** Coefficient d'impact — NON CALIBRÉ, exposé en paramètre (SPEC §4.6). */
  readonly etaImpact: number;
  /** Profondeur de référence pour l'impact en racine carrée. */
  readonly depth: number;
  /** Coût de portage par période. */
  readonly carryRate: number;
  /** Aversion au risque. */
  readonly kappa: number;
  /** ES par unité d'exposition sur l'horizon d'une période. */
  readonly esPerUnit: number;
  /**
   * Coût d'une rupture de solde. Fortement asymétrique : pénalité de service plus
   * financement d'urgence. C'est ce terme, et lui seul, qui justifie l'existence d'un
   * buffer — sans lui l'optimum serait un solde nul.
   *
   * Il est facturé **en espérance** — coût × P(flux < −solde) — et non en comptant les
   * ruptures observées : voir l'exposé du problème de résolution dans `tail.ts`.
   */
  readonly breachCost: number;
}

/** Coût d'exécution d'un ordre de taille `q` : spread proportionnel + impact en racine carrée. */
export function executionCost(q: number, p: CostParams): number {
  const size = Math.abs(q);
  if (size === 0) return 0;
  const spread = (p.spreadBps / 10_000) * size;
  const impact = p.depth > 0 ? p.etaImpact * size * Math.sqrt(size / p.depth) : 0;
  return spread + impact;
}

export interface PolicyOutcome {
  /** Coût total moyen par trajectoire. */
  readonly cost: number;
  readonly carry: number;
  readonly fixed: number;
  readonly variable: number;
  readonly risk: number;
  readonly breach: number;
  /** Nombre moyen de rééquilibrages par trajectoire. */
  readonly rebalances: number;
  /** Nombre moyen de ruptures effectivement *observées* — diagnostic, non tarifé. */
  readonly breaches: number;
  /** Probabilité de rupture moyenne par période, telle que tarifée. */
  readonly breachProbability: number;
  /** Solde moyen porté — la métrique de capital immobilisé. */
  readonly avgBalance: number;
}

/**
 * Évalue une politique de bandes sur un jeu de trajectoires de flux nets.
 *
 * Les trajectoires sont fournies par l'appelant et **réutilisées à l'identique** pour
 * tous les candidats de la recherche : c'est la technique des nombres aléatoires
 * communs. Sans elle, l'optimiseur compare des candidats évalués sur des tirages
 * différents et poursuit le bruit de simulation plutôt que le minimum.
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
      // Le risque de rupture est tarifé sur le solde *avant* le choc : c'est
      // l'information dont dispose le moteur au moment de décider.
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
 * Rééchantillonnage bootstrap de flux nets historiques.
 *
 * Tirage indépendant avec remise : préserve la distribution marginale des flux nets —
 * donc les queues épaisses héritées des montants log-normaux — mais détruit leur
 * autocorrélation. Limitation assumée : un bootstrap par blocs conserverait la
 * dépendance temporelle, au prix d'un paramètre de longueur de bloc à calibrer.
 */
export function bootstrapPaths(
  history: readonly number[],
  pathCount: number,
  pathLength: number,
  seed: number,
): number[][] {
  if (history.length === 0) throw new RangeError('historique vide');
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
