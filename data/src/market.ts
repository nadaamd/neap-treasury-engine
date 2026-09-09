/**
 * Simulateur de trajectoires de change.
 *
 * Tient lieu d'historique de marché tant que les Data Streams ne sont pas câblés
 * (SPEC §5.2). Il ne s'agit pas de prédire le change mais de produire des séries
 * qui possèdent les deux propriétés qui comptent pour le moteur de risque :
 *
 *   1. **groupement de volatilité** — les périodes agitées succèdent aux périodes agitées ;
 *      c'est ce qui donne son sens à la volatilité EWMA plutôt qu'à une variance glissante ;
 *   2. **queues épaisses** — innovations de Student, pas gaussiennes ; c'est ce qui creuse
 *      l'écart entre l'ES normale et l'ES par simulation historique filtrée.
 *
 * Un simulateur gaussien homoscédastique rendrait les deux estimateurs identiques et
 * viderait la décision D4 de son contenu.
 *
 * Modèle : GARCH(1,1) par devise, innovations de Student standardisées, corrélation
 * transversale imposée par Cholesky.
 */

import { Rng } from './random.ts';
import type { Currency } from './types.ts';
import { cholesky } from '../../engine/src/linalg.ts';
import type { Matrix } from '../../engine/src/linalg.ts';

/** Devises détenues, hors numéraire. Le USD est le numéraire : son rendement est nul par construction. */
export const RISK_CURRENCIES: readonly Currency[] = ['EUR', 'GBP', 'BRL'];

export interface GarchSpec {
  /** Volatilité annualisée de long terme, en fraction (0.07 = 7 %). */
  readonly annualVol: number;
  /** Poids du choc récent. */
  readonly alpha: number;
  /** Persistance. */
  readonly beta: number;
  /** Degrés de liberté de la loi de Student (ν > 4 pour que la kurtosis soit finie). */
  readonly nu: number;
}

export const FX_SPECS: Readonly<Record<string, GarchSpec>> = {
  EUR: { annualVol: 0.07, alpha: 0.08, beta: 0.90, nu: 6 },
  GBP: { annualVol: 0.08, alpha: 0.09, beta: 0.89, nu: 6 },
  BRL: { annualVol: 0.16, alpha: 0.12, beta: 0.85, nu: 5 },
};

/** Corrélations transversales des rendements quotidiens contre USD. */
export const FX_CORRELATION: Matrix = [
  [1.0, 0.70, 0.30],
  [0.70, 1.0, 0.28],
  [0.30, 0.28, 1.0],
];

const TRADING_DAYS = 252;

/** Innovation de Student standardisée (variance unitaire), ν entier. */
function studentT(rng: Rng, nu: number): number {
  const z = rng.normal();
  let chi2 = 0;
  for (let i = 0; i < nu; i++) {
    const g = rng.normal();
    chi2 += g * g;
  }
  const t = z / Math.sqrt(chi2 / nu);
  return t / Math.sqrt(nu / (nu - 2)); // standardisation : variance = 1
}

export interface MarketPath {
  /** Rendements logarithmiques quotidiens, indexés par devise. */
  readonly returns: Readonly<Record<string, number[]>>;
  /** Volatilité conditionnelle quotidienne réalisée par le modèle — sert de témoin aux tests. */
  readonly conditionalVol: Readonly<Record<string, number[]>>;
}

export function simulateMarket(seed: number, days: number): MarketPath {
  const rng = new Rng(seed);
  const chol = cholesky(FX_CORRELATION);
  if (chol === null) throw new Error('matrice de corrélation de change non définie positive');

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
    // Innovations standardisées puis corrélées par Cholesky.
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
