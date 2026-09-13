/**
 * FX path simulator.
 *
 * Stands in for market history until Data Streams are wired in (SPEC §5.2). The point is
 * not to predict FX but to produce series with the two properties that matter to the risk
 * engine:
 *
 *   1. **volatility clustering** — turbulent periods follow turbulent periods; this is
 *      what makes EWMA volatility meaningful rather than a rolling variance;
 *   2. **fat tails** — Student innovations, not Gaussian ones; this is what opens the gap
 *      between normal ES and filtered historical simulation ES.
 *
 * A homoscedastic Gaussian simulator would make both estimators identical and empty
 * decision D4 of its content.
 *
 * Model: GARCH(1,1) per currency, standardised Student innovations, cross-sectional
 * correlation imposed by Cholesky.
 */

import { Rng } from './random.ts';
import type { Currency } from './types.ts';
import { cholesky } from '../../engine/src/linalg.ts';
import type { Matrix } from '../../engine/src/linalg.ts';

/** Currencies held, excluding the numeraire. USD is the numeraire: its return is zero by construction. */
export const RISK_CURRENCIES: readonly Currency[] = ['EUR', 'GBP', 'BRL'];

export interface GarchSpec {
  /** Long-run annualised volatility, as a fraction (0.07 = 7%). */
  readonly annualVol: number;
  /** Weight of the recent shock. */
  readonly alpha: number;
  /** Persistence. */
  readonly beta: number;
  /** Degrees of freedom of the Student law (ν > 4 so that kurtosis is finite). */
  readonly nu: number;
}

export const FX_SPECS: Readonly<Record<string, GarchSpec>> = {
  EUR: { annualVol: 0.07, alpha: 0.08, beta: 0.90, nu: 6 },
  GBP: { annualVol: 0.08, alpha: 0.09, beta: 0.89, nu: 6 },
  BRL: { annualVol: 0.16, alpha: 0.12, beta: 0.85, nu: 5 },
};

/** Cross-sectional correlations of daily returns against USD. */
export const FX_CORRELATION: Matrix = [
  [1.0, 0.70, 0.30],
  [0.70, 1.0, 0.28],
  [0.30, 0.28, 1.0],
];

const TRADING_DAYS = 252;

/** Standardised Student innovation (unit variance), integer ν. */
function studentT(rng: Rng, nu: number): number {
  const z = rng.normal();
  let chi2 = 0;
  for (let i = 0; i < nu; i++) {
    const g = rng.normal();
    chi2 += g * g;
  }
  const t = z / Math.sqrt(chi2 / nu);
  return t / Math.sqrt(nu / (nu - 2)); // standardisation: variance = 1
}

export interface MarketPath {
  /** Daily log returns, indexed by currency. */
  readonly returns: Readonly<Record<string, number[]>>;
  /** Daily conditional volatility realised by the model — used as a control in the tests. */
  readonly conditionalVol: Readonly<Record<string, number[]>>;
}

export function simulateMarket(seed: number, days: number): MarketPath {
  const rng = new Rng(seed);
  const chol = cholesky(FX_CORRELATION);
  if (chol === null) throw new Error('FX correlation matrix is not positive definite');

  const names = RISK_CURRENCIES;
  const n = names.length;
  const returns: Record<string, number[]> = {};
  const condVol: Record<string, number[]> = {};
  const sigma2: number[] = [];
  const omega: number[] = [];

  names.forEach((c, i) => {
    const spec = FX_SPECS[c]!;
    const daily = spec.annualVol / Math.sqrt(TRADING_DAYS);
    const longRunVar = daily * daily;
    omega[i] = longRunVar * (1 - spec.alpha - spec.beta);
    sigma2[i] = longRunVar;
    returns[c] = [];
    condVol[c] = [];
  });

  for (let t = 0; t < days; t++) {
    // Standardised innovations, then correlated through Cholesky.
    const raw = names.map((c) => studentT(rng, FX_SPECS[c]!.nu));
    const correlated = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j <= i; j++) s += chol[i]![j]! * raw[j]!;
      correlated[i] = s;
    }

    for (let i = 0; i < n; i++) {
      const c = names[i]!;
      const spec = FX_SPECS[c]!;
      const sd = Math.sqrt(sigma2[i]!);
      const eps = sd * correlated[i]!;
      returns[c]!.push(eps);
      condVol[c]!.push(sd);
      sigma2[i] = omega[i]! + spec.alpha * eps * eps + spec.beta * sigma2[i]!;
    }
  }

  return { returns, conditionalVol: condVol };
}
