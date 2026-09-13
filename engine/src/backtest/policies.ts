/**
 * The four policies being compared — SPEC §18.2.
 *
 * They share the same band mechanics and the same execution engine: all that changes is
 * how the bands are obtained, and how often state is inspected. That is deliberate — if
 * the policies also differed in their plumbing, the comparison would measure something
 * other than what we want to measure.
 */

import type { Currency } from '../../../data/src/types.ts';
import { millerOrrBands } from '../bands/millerOrr.ts';
import type { Bands } from '../bands/millerOrr.ts';
import { bootstrapPaths } from '../bands/simulate.ts';
import type { CostParams } from '../bands/simulate.ts';
import { solveBands } from '../bands/solver.ts';
import { empiricalLeftTail } from '../bands/tail.ts';
import { mean, stdev } from '../../../data/src/stats.ts';
import { CURRENCIES, CURRENCY_COSTS, EPOCHS_PER_DAY, ES_FACTOR_975 } from './config.ts';
import type { BacktestConfig } from './config.ts';
import type { PolicyBands, PolicyKind } from './types.ts';

/**
 * Worst observed intraday liquidity need.
 *
 * This is how a treasury sizes pre-funding in practice: look at the worst day of the
 * recent past and provision that much. The method is robust and expensive — it ignores
 * the cost of capital, the structure of the flows and FX risk.
 *
 * The first attempt measured the worst *daily net outflow*. That was wrong, and the
 * backtest showed it unambiguously: on a structurally inbound corridor such as the euro,
 * the least favourable net outflow is close to zero, the band became negligible and the
 * policy supposed to be the most conservative racked up four hundred and forty breaches.
 * A positive net balance over the day says nothing about the trough crossed along the
 * way.
 *
 * The right quantity is the **maximum drawdown of cumulative flow within a day**: how
 * much liquidity you must hold in the morning to absorb the worst run of outflows before
 * inflows catch up. It is measured day by day and the worst is kept, which bounds the
 * buffer to a one-day replenishment horizon — beyond that, a treasury tops up rather
 * than provisions.
 */
function worstIntradayDrawdown(epochFlows: readonly number[]): number {
  let worst = 0;
  const days = Math.floor(epochFlows.length / EPOCHS_PER_DAY);
  for (let d = 0; d < days; d++) {
    let cumulative = 0;
    let peak = 0;
    for (let i = 0; i < EPOCHS_PER_DAY; i++) {
      cumulative += epochFlows[d * EPOCHS_PER_DAY + i]!;
      if (cumulative > peak) peak = cumulative;
      const drawdown = peak - cumulative;
      if (drawdown > worst) worst = drawdown;
    }
  }
  return Math.max(worst, 1);
}

/** ES per unit of exposure over a one-period horizon, from the day's volatility. */
export function esPerUnit(dailyVol: number): number {
  return ES_FACTOR_975 * dailyVol * Math.sqrt(1 / EPOCHS_PER_DAY);
}

function solveFor(
  flows: readonly number[],
  currency: Currency,
  dailyVol: number,
  cfg: BacktestConfig,
  seed: number,
  override?: CostParams,
): Bands {
  const drift = mean(flows);
  const centred = flows.map((x) => x - drift);
  const sigma = Math.max(stdev(centred), 1);
  const base = override ?? CURRENCY_COSTS[currency]!.costs;
  const costs = { ...base, esPerUnit: esPerUnit(dailyVol) };

  // The bands are warm-started by Miller-Orr on the driftless series — that is its
  // assumption set — then refined numerically on the real flows, drift included.
  const warmStart = millerOrrBands({
    gammaFixed: costs.gammaFixed,
    flowSigma: sigma,
    carryRate: costs.carryRate,
    lower: 0,
  });
  const spread = Math.max(warmStart.target - warmStart.lower, 1);

  return solveBands({
    paths: bootstrapPaths(flows, cfg.solverPaths, cfg.solverPathLength, seed),
    costs,
    tail: empiricalLeftTail(flows),
    warmStart,
    floor: 0,
    initialStep: spread / 2,
    tolerance: spread / 256,
    maxEvaluations: 3000,
  }).bands;
}

export interface PolicyInput {
  /** Flows of the calibration window — the strict past. */
  readonly calibration: Record<Currency, number[]>;
  /**
   * Flows of the evaluation window. Reserved for CLAIRVOYANT, which is a **reference
   * bound** and not an implementable policy.
   */
  readonly evaluation: Record<Currency, number[]>;
  /** Daily volatility per currency, estimated on the calibration window. */
  readonly dailyVol: Record<Currency, number>;
  readonly cfg: BacktestConfig;
  readonly seed: number;
  /**
   * Per-currency costs overriding the repository defaults.
   *
   * Without this explicit pass-through, the solver always read the module constants and
   * the dashboard sliders had no effect on the bands: the page displayed parameters it
   * claimed to be varying. The contract check between the API and the page caught it; a
   * screenshot would not have.
   */
  readonly costs?: Readonly<Record<string, CostParams>>;
}

export function buildPolicy(kind: PolicyKind, input: PolicyInput): PolicyBands {
  const bands = {} as Record<Currency, Bands>;

  for (const c of CURRENCIES) {
    const calib = input.calibration[c]!;
    switch (kind) {
      case 'STATIC': {
        // Conservative pre-funding, never optimised: provision the worst observed day,
        // top up when the balance falls below a quarter of it, sweep the excess only
        // beyond three times it.
        const z = worstIntradayDrawdown(calib);
        bands[c] = { lower: 0.25 * z, target: z, upper: 3 * z };
        break;
      }
      case 'CALENDAR': {
        // Same sizing, but decisions at a fixed time: the most widespread treasury
        // practice, and the realistic control in the comparison.
        const z = worstIntradayDrawdown(calib);
        bands[c] = { lower: 0, target: z, upper: Number.POSITIVE_INFINITY };
        break;
      }
      case 'NEAP':
        bands[c] = solveFor(calib, c, input.dailyVol[c]!, input.cfg, input.seed, input.costs?.[c]);
        break;
      case 'CLAIRVOYANT':
        bands[c] = solveFor(
          input.evaluation[c]!,
          c,
          input.dailyVol[c]!,
          input.cfg,
          input.seed,
          input.costs?.[c],
        );
        break;
    }
  }

  return { bands, calendarOnly: kind === 'CALENDAR' };
}
