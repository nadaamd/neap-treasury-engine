/**
 * Corridor calibration — SPEC §17.1 and §17.3.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONESTY WARNING
 * These values are orders of magnitude derived from public aggregates, not
 * measurements. No institution publishes its flows per corridor. Each parameter
 * carries its reasoning and its confidence level; the repository README repeats
 * this warning for the judges.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Reasoning sources:
 *  - euro-area retail payment volumes and seasonality: ECB payment statistics;
 *  - average sizes and directional imbalance of remittance corridors: the World
 *    Bank's "Remittance Prices Worldwide" database;
 *  - fixed cost of the slow rail: correspondent-bank international transfer fee
 *    schedules, an order of magnitude of tens of dollars;
 *  - fixed cost of the fast rail: USDC-denominated gas on Arc, an order of magnitude
 *    of one cent.
 *
 * The quantity that matters is not the absolute value of any parameter but the
 * **ratio of fixed costs between rails** (~10³–10⁴), which alone drives the collapse
 * of the optimal buffer demonstrated by the backtest.
 */

import type { CorridorSpec } from '../src/types.ts';

export const CORRIDORS: readonly CorridorSpec[] = [
  {
    id: 'EURUSD-FAST',
    base: 'EUR',
    quote: 'USD',
    rail: 'FAST',
    // Main corridor, a mix of corporate and retail flows.
    dailyVolumeUsd: 24_000_000,
    avgTicketUsd: 2_400,
    tailSigma: 1.35, // fat tail: a few corporate transfers dominate the volume
    imbalance: 0.06, // near-balanced, slight outbound bias
    gammaFixedUsd: 0.02, // Arc gas in USDC
    latencySec: 0.35, // Arc's measured finality
    etaImpact: 0.002, // UNCALIBRATED — relative cost of a full-depth order, ~20 bps
    maxDepthUsd: 5_000_000,
  },
  {
    id: 'GBPUSD-FAST',
    base: 'GBP',
    quote: 'USD',
    rail: 'FAST',
    dailyVolumeUsd: 9_000_000,
    avgTicketUsd: 1_900,
    tailSigma: 1.3,
    imbalance: -0.04,
    gammaFixedUsd: 0.02,
    latencySec: 0.35,
    etaImpact: 0.0025,
    maxDepthUsd: 2_000_000,
  },
  {
    id: 'EURGBP-FAST',
    base: 'EUR',
    quote: 'GBP',
    rail: 'FAST',
    dailyVolumeUsd: 6_000_000,
    avgTicketUsd: 1_500,
    tailSigma: 1.25,
    imbalance: 0.02,
    gammaFixedUsd: 0.02,
    latencySec: 0.35,
    etaImpact: 0.003,
    maxDepthUsd: 1_500_000,
  },
  {
    /**
     * The "slow rail" corridor of the hybrid stance (decision D2).
     *
     * No credible BRL stablecoin exists: this corridor settles through a correspondent
     * bank, with a fixed cost three orders of magnitude higher and a two-day latency.
     * Strongly imbalanced, like every remittance corridor: flows go overwhelmingly one
     * way.
     *
     * This corridor is what makes the optimisation problem interesting — without it, all
     * rails are alike and the trade-off disappears.
     */
    id: 'EURBRL-SLOW',
    base: 'EUR',
    quote: 'BRL',
    rail: 'SLOW',
    dailyVolumeUsd: 3_000_000,
    avgTicketUsd: 420, // typical size of a retail remittance
    tailSigma: 1.15,
    imbalance: 0.55, // 77.5% of payments go EUR → BRL
    gammaFixedUsd: 25, // correspondent-bank transfer fee
    latencySec: 2 * 24 * 3600, // T+2
    etaImpact: 0,  // over-the-counter negotiated price, no book impact
    maxDepthUsd: Number.POSITIVE_INFINITY,
  },
];

export const CORRIDORS_BY_ID = new Map(CORRIDORS.map((c) => [c.id, c]));

/** Ratio of fixed costs between the slow and fast rails — the structural quantity. */
export const GAMMA_RATIO =
  CORRIDORS.find((c) => c.rail === 'SLOW')!.gammaFixedUsd /
  CORRIDORS.find((c) => c.rail === 'FAST')!.gammaFixedUsd;
