/**
 * Covariance **conditionnelle** : volatilités EWMA du jour sur la diagonale, corrélation
 * estimée sur les résidus standardisés puis régularisée par shrinkage.
 *
 *   Σ_t = D_t · R · D_t     avec D_t = diag(σ_{1,t} … σ_{n,t})
 *
 * Pourquoi séparer volatilité et corrélation plutôt que de shrinker directement la
 * covariance des rendements bruts : la volatilité bouge vite et la corrélation bouge
 * lentement. Les estimer ensemble sur une même fenêtre force un compromis perdant —
 * fenêtre courte, corrélation bruitée ; fenêtre longue, volatilité périmée. C'est la
 * logique des modèles DCC, appliquée ici dans sa forme la plus simple.
 *
 * Conséquence pratique, et elle est importante pour la comparaison des estimateurs de
 * risque : une ES gaussienne bâtie sur cette covariance conditionnelle et une ES par FHS
 * partagent désormais le **même niveau** de volatilité. Leur écart ne mesure plus qu'une
 * chose — l'épaisseur des queues. C'est la seule comparaison honnête.
 */

import { ledoitWolf } from './covariance.ts';
import { zeros } from '../linalg.ts';
import type { Matrix } from '../linalg.ts';

export interface ConditionalCovariance {
  /** Σ_t = D R D. */
  readonly sigma: Matrix;
  /** Matrice de corrélation régularisée. */
  readonly correlation: Matrix;
  /** Intensité de shrinkage appliquée à la corrélation. */
  readonly intensity: number;
}

export function conditionalCovariance(
  residuals: readonly (readonly number[])[],
  currentVol: readonly number[],
): ConditionalCovariance {
  const n = currentVol.length;
  const { sigma: sz, intensity } = ledoitWolf(residuals);

  // Les résidus standardisés ont une variance proche de 1 sans l'être exactement :
  // on normalise explicitement pour obtenir une vraie matrice de corrélation.
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
