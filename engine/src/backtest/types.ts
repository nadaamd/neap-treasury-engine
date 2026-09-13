/** Backtest protocol types — SPEC §18, decision D10. */

import type { Currency } from '../../../data/src/types.ts';
import type { Bands } from '../bands/millerOrr.ts';
import type { CostParams } from '../bands/simulate.ts';

export type PolicyKind = 'STATIC' | 'CALENDAR' | 'NEAP' | 'CLAIRVOYANT';

export interface PolicyBands {
  readonly bands: Record<Currency, Bands>;
  /** True when the policy only decides at a fixed time, regardless of state. */
  readonly calendarOnly: boolean;
}

export interface WindowMetrics {
  /** Average idle capital, across all currencies. */
  readonly capital: number;
  /** Average portfolio ES 97.5%, measured at end of day. */
  readonly es: number;
  /** Cumulative execution costs — expected to be **higher** for NEAP. */
  readonly executionCost: number;
  /** Cumulative carry cost. */
  readonly carryCost: number;
  /** Number of balance breaches. Hard constraint: must stay at zero. */
  readonly breaches: number;
  readonly rebalances: number;
  /** Total cost: carry + execution. This is the comparison criterion. */
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
  /** Half-width of the 95% confidence interval. */
  readonly halfWidth: number;
  readonly n: number;
}

export interface BacktestSummary {
  readonly seeds: number;
  readonly windows: number;
  readonly metrics: Record<PolicyKind, Record<keyof WindowMetrics, Interval>>;
  /**
   * Cost of estimation uncertainty, as a fraction of CLAIRVOYANT's cost.
   *
   *   (NEAP cost − CLAIRVOYANT cost) / CLAIRVOYANT cost
   *
   * CLAIRVOYANT was initially designed as an upper bound — the optimal policy if you
   * knew the period ahead. The backtest showed it is not one: NEAP beats it four times
   * out of five, by a percent or two. The reason is that the solver is heuristic and
   * that the measured criterion — *realised* out-of-sample cost — is not the one it
   * minimises.
   *
   * Rather than dressing up a bound that is not a bound, the quantity is renamed for
   * what it actually measures: the gap between calibrating on the past and calibrating
   * on the period itself. A confidence interval containing zero is then a result in
   * itself — it says estimation error is not the binding factor.
   */
  readonly estimationCost: Interval;
}

export interface CurrencyCosts {
  readonly costs: CostParams;
  readonly settlementDays: number;
}
