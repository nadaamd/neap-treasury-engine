/**
 * Covariance matrix estimation with Ledoit-Wolf (2004) shrinkage.
 *
 * The problem: with n currencies and T observations, the sample covariance is more
 * ill-conditioned the smaller T/n is. Its inverse — used by any portfolio optimisation
 * or hedge ratio — then amplifies estimation noise instead of damping it.
 *
 * Shrinkage pulls the estimator towards a well-conditioned target (here m·I, where m is
 * the average variance), with an intensity chosen to minimise expected squared error.
 * The intensity is computed, not hand-tuned — that is the whole point.
 *
 * Ledoit, O. & Wolf, M. (2004), "A well-conditioned estimator for large-dimensional
 * covariance matrices", Journal of Multivariate Analysis.
 */

import { frobeniusNormSq, identity, trace, zeros } from '../linalg.ts';
import type { Matrix } from '../linalg.ts';

export interface ShrinkageResult {
  /** Retained estimator: δ·target + (1−δ)·sample. */
  readonly sigma: Matrix;
  /** Sample covariance, kept for comparison. */
  readonly sample: Matrix;
  /** Shrinkage target: m·I. */
  readonly target: Matrix;
  /** Intensity δ ∈ [0,1] — 0 = pure sample, 1 = pure target. */
  readonly intensity: number;
}

/** `x` is a T × n matrix of returns (rows = dates, columns = currencies). */
export function ledoitWolf(x: readonly (readonly number[])[]): ShrinkageResult {
  const T = x.length;
  if (T < 2) throw new RangeError('at least two observations are required');
  const n = x[0]!.length;

  // Centring.
  const means = new Array<number>(n).fill(0);
  for (const row of x) for (let j = 0; j < n; j++) means[j] = means[j]! + row[j]! / T;
  const c: number[][] = x.map((row) => row.map((v, j) => v - means[j]!));

  // Sample covariance (divisor T, consistent with the Ledoit-Wolf derivation).
  const sample = zeros(n);
  for (const row of c) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) sample[i]![j] = sample[i]![j]! + (row[i]! * row[j]!) / T;
    }
  }

  // Target: average variance on the diagonal.
  const m = trace(sample) / n;
  const target = identity(n).map((row) => row.map((v) => v * m));

  // Dispersion of the sample estimator around the target.
  const d2 = frobeniusNormSq(sample.map((row, i) => row.map((v, j) => v - target[i]![j]!)));

  // Estimation variance of the sample estimator.
  let b2bar = 0;
  for (const row of c) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const d = row[i]! * row[j]! - sample[i]![j]!;
        acc += d * d;
      }
    }
    b2bar += acc / n;
  }
  b2bar /= T * T;

  const b2 = Math.min(b2bar, d2);
  const intensity = d2 === 0 ? 0 : b2 / d2;

  const sigma = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sigma[i]![j] = intensity * target[i]![j]! + (1 - intensity) * sample[i]![j]!;
    }
  }

  // Defensive symmetrisation: rounding errors can misalign Σ[i][j] and Σ[j][i], which
  // makes Cholesky fail on a matrix that is in fact positive definite.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const avg = (sigma[i]![j]! + sigma[j]![i]!) / 2;
      sigma[i]![j] = avg;
      sigma[j]![i] = avg;
    }
  }

  return { sigma, sample, target, intensity };
}
