/**
 * Construction des résidus standardisés alimentant la FHS.
 *
 * z_{t,i} = r_{t,i} / σ_{t,i}, où σ_{t,i} est la volatilité EWMA connue *avant*
 * d'observer r_{t,i}. Les vecteurs transversaux sont conservés intacts : c'est ce qui
 * transporte la corrélation et la dépendance de queue jusqu'au calcul d'ES.
 */

import { ewmaVolNext, ewmaVolSeries, RISKMETRICS_LAMBDA } from './ewma.ts';

export interface ResidualSet {
  /** Matrice T × n de résidus standardisés. */
  readonly residuals: number[][];
  /** Volatilité conditionnelle courante par devise (prévision pour la période suivante). */
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
