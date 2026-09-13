/** Domain types for payment flows. See SPEC §15.1. */

export type Currency = 'USD' | 'EUR' | 'GBP' | 'BRL';

/**
 * Cost regime of a corridor.
 *
 * FAST: stablecoin settlement on Arc — fixed cost around a cent, sub-second finality.
 * SLOW: correspondent-bank rail — fixed cost of tens of dollars, T+1/T+2.
 *
 * The ratio of fixed costs between the two regimes is the only truly structural quantity
 * in the model (SPEC §17.3): it is what produces the buffer collapse.
 */
export type Rail = 'FAST' | 'SLOW';

export interface CorridorSpec {
  readonly id: string;
  /** Currency received when the corridor is used in the base → quote direction. */
  readonly base: Currency;
  /** Currency paid in that same direction. */
  readonly quote: Currency;
  readonly rail: Rail;
  /** Daily volume, in USD equivalent. */
  readonly dailyVolumeUsd: number;
  /** Average payment size, in USD equivalent. */
  readonly avgTicketUsd: number;
  /** Shape parameter of the log-normal amount distribution: larger means fatter tail. */
  readonly tailSigma: number;
  /**
   * Directional imbalance ∈ [-1, 1].
   * 0 = balanced corridor; +0.5 = 75% of payments go from base to quote.
   * This term is what creates the drift, and therefore what invalidates Miller-Orr's
   * symmetric bands (SPEC §4.2).
   */
  readonly imbalance: number;
  /** Fixed cost of a rebalance on this rail, in USD. */
  readonly gammaFixedUsd: number;
  /** Settlement latency, in seconds. */
  readonly latencySec: number;
  /** Market impact coefficient — not calibratable (SPEC §4.6), exposed as a parameter. */
  readonly etaImpact: number;
  /** Indicative usable depth, in USD. */
  readonly maxDepthUsd: number;
}

export interface FlowEvent {
  /** Timestamp, ms since epoch. */
  readonly ts: number;
  readonly corridorId: string;
  /** Currency whose balance increases. */
  readonly receive: Currency;
  /** Currency whose balance decreases. */
  readonly pay: Currency;
  /**
   * Amount in USD equivalent.
   * Conversion into each currency's native units happens in the engine layer, which has
   * the rates; the generator stays market-agnostic.
   */
  readonly notionalUsd: number;
}

export type NetByCurrency = Record<Currency, number>;

export interface FlowBucket {
  readonly startTs: number;
  readonly net: NetByCurrency;
  readonly count: number;
}
