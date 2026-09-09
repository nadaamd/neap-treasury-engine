/**
 * Estimation de la matrice de covariance avec shrinkage de Ledoit-Wolf (2004).
 *
 * Problème traité : avec n devises et T observations, la covariance empirique est
 * d'autant plus mal conditionnée que T/n est petit. Son inverse — utilisée par toute
 * optimisation de portefeuille ou tout ratio de couverture — amplifie alors le bruit
 * d'estimation au lieu de l'atténuer.
 *
 * Le shrinkage tire l'estimateur vers une cible bien conditionnée (ici m·I, où m est la
 * variance moyenne), avec une intensité choisie pour minimiser l'erreur quadratique
 * attendue. L'intensité est calculée, pas réglée à la main — c'est tout l'intérêt.
 *
 * Ledoit, O. & Wolf, M. (2004), « A well-conditioned estimator for large-dimensional
 * covariance matrices », Journal of Multivariate Analysis.
 */

import { frobeniusNormSq, identity, trace, zeros } from '../linalg.ts';
import type { Matrix } from '../linalg.ts';

export interface ShrinkageResult {
  /** Estimateur retenu : δ·cible + (1−δ)·empirique. */
  readonly sigma: Matrix;
  /** Covariance empirique, conservée pour comparaison. */
  readonly sample: Matrix;
  /** Cible du shrinkage : m·I. */
  readonly target: Matrix;
  /** Intensité δ ∈ [0,1] — 0 = empirique pure, 1 = cible pure. */
  readonly intensity: number;
}

/** `x` est une matrice T × n de rendements (lignes = dates, colonnes = devises). */
export function ledoitWolf(x: readonly (readonly number[])[]): ShrinkageResult {
  const T = x.length;
  if (T < 2) throw new RangeError('au moins deux observations sont requises');
  const n = x[0]!.length;

  // Centrage.
  const means = new Array<number>(n).fill(0);
  for (const row of x) for (let j = 0; j < n; j++) means[j] = means[j]! + row[j]! / T;
  const c: number[][] = x.map((row) => row.map((v, j) => v - means[j]!));

  // Covariance empirique (diviseur T, cohérent avec la dérivation de Ledoit-Wolf).
  const sample = zeros(n);
  for (const row of c) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) sample[i]![j] = sample[i]![j]! + (row[i]! * row[j]!) / T;
    }
  }

  // Cible : variance moyenne sur la diagonale.
  const m = trace(sample) / n;
  const target = identity(n).map((row) => row.map((v) => v * m));

  // Dispersion de l'empirique autour de la cible.
  const d2 = frobeniusNormSq(sample.map((row, i) => row.map((v, j) => v - target[i]![j]!)));

  // Variance d'estimation de l'empirique.
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

  // Symétrisation défensive : les erreurs d'arrondi peuvent désaligner Σ[i][j] et Σ[j][i],
  // ce qui fait échouer Cholesky sur une matrice pourtant définie positive.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const avg = (sigma[i]![j]! + sigma[j]![i]!) / 2;
      sigma[i]![j] = avg;
      sigma[j]![i] = avg;
    }
  }

  return { sigma, sample, target, intensity };
}
