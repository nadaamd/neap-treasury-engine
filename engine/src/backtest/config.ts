/**
 * Backtest parameters.
 *
 * Every value is visible here rather than scattered: a number is only worth something if
 * you can read at a glance under which assumptions it was obtained.
 */

import type { Currency } from '../../../data/src/types.ts';
import type { CurrencyCosts } from './types.ts';

export const EPOCHS_PER_DAY = 96;
export const EPOCH_MS = 15 * 60 * 1000;
export const DAY_MS = 86_400_000;

/** Currencies carrying a band. The dollar is the numeraire and funds the others. */
export const CURRENCIES: readonly Currency[] = ['EUR', 'GBP', 'BRL'];

/** The institution's annual cost of capital. */
export const ANNUAL_CARRY = 0.06;
export const CARRY_PER_EPOCH = ANNUAL_CARRY / 365 / EPOCHS_PER_DAY;

/** Cost of a balance breach: service penalty plus emergency funding (D14). */
export const BREACH_COST = 50_000;

/** Risk aversion: weight of the FX term in the objective function. */
export const KAPPA = 0.1;

/** Gaussian ES multiplier at 97.5% — φ(z)/(1−α). */
export const ES_FACTOR_975 = 2.337803;

/**
 * Market impact coefficient.
 *
 * It is **not calibrated** — Arc's real book depth is unknown (SPEC §4.6). But an
 * implausible value would make the whole backtest useless, and the first attempt was:
 * `eta = 0.05` means a 5% cost for an order equal to the quoted depth, hence 158 basis
 * points at only 10% of that depth. Execution cost then crushed carry cost by a factor
 * of 280, and the result measured nothing but an invented parameter.
 *
 * With square-root impact, `eta` reads directly as the relative cost of an order that
 * consumes the entire depth. Twenty to twenty-five basis points for a liquid FX book is
 * a defensible order of magnitude. The sensitivity of the result to this parameter is
 * published alongside the result itself.
 */
export const ETA_EUR = 0.002;
export const ETA_GBP = 0.0025;

/**
 * Per-currency costs.
 *
 * EUR and GBP settle in stablecoin on Arc: fixed cost around a cent, sub-second finality.
 * BRL has no credible stablecoin and goes through a correspondent bank: fixed cost three
 * orders of magnitude higher, T+2 settlement. That contrast is the entire point of the
 * hybrid stance (D2).
 */
export const CURRENCY_COSTS: Readonly<Record<string, CurrencyCosts>> = {
  EUR: {
    costs: {
      gammaFixed: 0.02,
      spreadBps: 2,
      etaImpact: ETA_EUR,
      depth: 5_000_000,
      carryRate: CARRY_PER_EPOCH,
      kappa: KAPPA,
      esPerUnit: 0,
      breachCost: BREACH_COST,
    },
    settlementDays: 1 / EPOCHS_PER_DAY,
  },
  GBP: {
    costs: {
      gammaFixed: 0.02,
      spreadBps: 3,
      etaImpact: ETA_GBP,
      depth: 2_000_000,
      carryRate: CARRY_PER_EPOCH,
      kappa: KAPPA,
      esPerUnit: 0,
      breachCost: BREACH_COST,
    },
    settlementDays: 1 / EPOCHS_PER_DAY,
  },
  BRL: {
    costs: {
      gammaFixed: 25,
      spreadBps: 35,
      etaImpact: 0,
      depth: 0,
      carryRate: CARRY_PER_EPOCH,
      kappa: KAPPA,
      esPerUnit: 0,
      breachCost: BREACH_COST,
    },
    settlementDays: 2,
  },
};

export interface BacktestConfig {
  readonly seeds: readonly number[];
  readonly startTs: number;
  /** Days used only to seed calibration, never evaluated. */
  readonly warmupDays: number;
  /** Length of one evaluation window, in days. */
  readonly evalDays: number;
  readonly windows: number;
  /** Bootstrap paths used when solving the bands. */
  readonly solverPaths: number;
  readonly solverPathLength: number;
}

export const DEFAULT_CONFIG: BacktestConfig = {
  seeds: Array.from({ length: 20 }, (_, i) => 1000 + i),
  startTs: Date.UTC(2025, 0, 1),
  warmupDays: 90,
  evalDays: 30,
  windows: 6,
  solverPaths: 200,
  solverPathLength: 300,
};

/** Reduced configuration for tests: same code paths, bounded cost. */
export const FAST_CONFIG: BacktestConfig = {
  ...DEFAULT_CONFIG,
  seeds: [1000, 1001],
  warmupDays: 45,
  evalDays: 15,
  windows: 2,
  solverPaths: 60,
  solverPathLength: 120,
};
