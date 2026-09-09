/** Types du protocole de backtest — SPEC §18, décision D10. */

import type { Currency } from '../../../data/src/types.ts';
import type { Bands } from '../bands/millerOrr.ts';
import type { CostParams } from '../bands/simulate.ts';

export type PolicyKind = 'STATIC' | 'CALENDAR' | 'FLOAT' | 'CLAIRVOYANT';

export interface PolicyBands {
  readonly bands: Record<Currency, Bands>;
  /** Vrai si la politique ne décide qu'à heure fixe, indépendamment de l'état. */
  readonly calendarOnly: boolean;
}

export interface WindowMetrics {
  /** Capital moyen immobilisé, toutes devises confondues. */
  readonly capital: number;
  /** ES 97,5 % moyenne du portefeuille, mesurée en fin de journée. */
  readonly es: number;
  /** Coûts d'exécution cumulés — attendus **en hausse** pour FLOAT. */
  readonly executionCost: number;
  /** Coût de portage cumulé. */
  readonly carryCost: number;
  /** Nombre de ruptures de solde. Contrainte dure : doit rester à zéro. */
  readonly breaches: number;
  readonly rebalances: number;
  /** Coût total : portage + exécution. C'est le critère de comparaison. */
  readonly totalCost: number;
}

export interface PolicyResult extends WindowMetrics {
  readonly kind: PolicyKind;
}

export interface SeedResult {
  readonly seed: number;
  readonly windows: number;
  readonly byPolicy: Record<PolicyKind, PolicyResult>;
}

export interface Interval {
  readonly mean: number;
  /** Demi-largeur de l'intervalle de confiance à 95 %. */
  readonly halfWidth: number;
  readonly n: number;
}

export interface BacktestSummary {
  readonly seeds: number;
  readonly windows: number;
  readonly metrics: Record<PolicyKind, Record<keyof WindowMetrics, Interval>>;
  /**
   * Coût de l'incertitude d'estimation, en fraction du coût de CLAIRVOYANT.
   *
   *   (coût FLOAT − coût CLAIRVOYANT) / coût CLAIRVOYANT
   *
   * CLAIRVOYANT était initialement conçu comme borne supérieure — la politique optimale
   * si l'on connaissait la période à venir. Le backtest a montré que ce n'en était pas
   * une : FLOAT le bat quatre fois sur cinq, d'un ou deux pour cent. La raison est que
   * le solveur est heuristique et que le critère mesuré — le coût *réalisé* hors
   * échantillon — n'est pas celui qu'il minimise.
   *
   * Plutôt que d'habiller une borne qui n'en est pas une, on renomme la grandeur pour ce
   * qu'elle mesure réellement : l'écart entre calibrer sur le passé et calibrer sur la
   * période elle-même. Un intervalle de confiance qui contient zéro est alors un
   * résultat en soi — il dit que l'erreur d'estimation n'est pas le facteur limitant.
   */
  readonly estimationCost: Interval;
}

export interface CurrencyCosts {
  readonly costs: CostParams;
  readonly settlementDays: number;
}
