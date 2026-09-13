/**
 * Construction of the standardised residuals that feed FHS.
 *
 * z_{t,i} = r_{t,i} / σ_{t,i}, where σ_{t,i} is the EWMA volatility known *before*
 * observing r_{t,i}. Cross-sectional vectors are kept intact: that is what carries
 * correlation and tail dependence through to the ES computation.
 */

import { ewmaVolNext, ewmaVolSeries, RISKMETRICS_LAMBDA } from './ewma.ts';

export interface ResidualSet {
  /** T × n matrix of standardised residuals. */
  readonly residuals: number[][];
  /** Current conditional volatility per currency (forecast for the next period). */
  readonly currentVol: number[];
  readonly names: readonly string[];
}

export function standardizedResiduals(
  returnsByName: Readonly<Record<string, readonly number[]>>,
  names: readonly string[],
  lambda: number = RISKMETRICS_LAMBDA,
  warmup = 20,
): ResidualSet {
  const perName = names.map((name) => {
    const r = returnsByName[name]!;
    const { vol } = ewmaVolSeries(r, lambda, warmup);
    const z = vol.map((s, k) => r[warmup + k]! / s);
    return { z, current: ewmaVolNext(r, lambda, warmup) };
  });

  const length = Math.min(...perName.map((p) => p.z.length));
  const residuals: number[][] = [];
  for (let t = 0; t < length; t++) residuals.push(perName.map((p) => p.z[t]!));

  return { residuals, currentVol: perName.map((p) => p.current), names };
}
