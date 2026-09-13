/**
 * **Conditional** covariance: today's EWMA volatilities on the diagonal, correlation
 * estimated on standardised residuals and then regularised by shrinkage.
 *
 *   Σ_t = D_t · R · D_t     with D_t = diag(σ_{1,t} … σ_{n,t})
 *
 * Why separate volatility from correlation rather than shrinking the covariance of raw
 * returns directly: volatility moves fast and correlation moves slowly. Estimating both
 * on a single window forces a losing trade-off — short window, noisy correlation; long
 * window, stale volatility. This is the logic of DCC models, applied here in its
 * simplest form.
 *
 * A practical consequence, and it matters for comparing risk estimators: a Gaussian ES
 * built on this conditional covariance and an FHS ES now share the **same level** of
 * volatility. Their gap measures one thing only — tail thickness. That is the only
 * honest comparison.
 */

import { ledoitWolf } from './covariance.ts';
import { zeros } from '../linalg.ts';
import type { Matrix } from '../linalg.ts';

export interface ConditionalCovariance {
  /** Σ_t = D R D. */
  readonly sigma: Matrix;
  /** Regularised correlation matrix. */
  readonly correlation: Matrix;
  /** Shrinkage intensity applied to the correlation. */
  readonly intensity: number;
}

export function conditionalCovariance(
  residuals: readonly (readonly number[])[],
  currentVol: readonly number[],
): ConditionalCovariance {
  const n = currentVol.length;
  const { sigma: sz, intensity } = ledoitWolf(residuals);

  // Standardised residuals have a variance close to 1 without being exactly 1:
  // normalise explicitly to obtain a genuine correlation matrix.
  const correlation = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      correlation[i]![j] = sz[i]![j]! / Math.sqrt(sz[i]![i]! * sz[j]![j]!);
    }
  }

  const sigma = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sigma[i]![j] = currentVol[i]! * correlation[i]![j]! * currentVol[j]!;
    }
  }

  return { sigma, correlation, intensity };
}
