/**
 * Volatilité conditionnelle EWMA (RiskMetrics).
 *
 *   σ²_t = λ σ²_{t−1} + (1 − λ) r²_{t−1}
 *
 * λ = 0.94 est la valeur RiskMetrics pour des données quotidiennes. Le choix d'un
 * estimateur à mémoire décroissante plutôt que d'une variance glissante n'est pas
 * cosmétique : les rendements de change présentent un groupement de volatilité, et une
 * fenêtre glissante y répond avec un retard égal à la moitié de sa largeur — puis
 * décroche brutalement quand le choc sort de la fenêtre.
 *
 * Discipline anti-anticipation : `σ_t` n'utilise que les rendements strictement
 * antérieurs à `t`. La fenêtre d'amorçage est renvoyée séparément et doit être exclue
 * de tout calcul en aval (SPEC §18.1).
 */

export const RISKMETRICS_LAMBDA = 0.94;

export interface EwmaSeries {
  /** σ_t pour t ∈ [warmup, T) — volatilité conditionnelle connue *avant* d'observer r_t. */
  readonly vol: number[];
  /** Index du premier élément de `vol` dans la série de rendements d'origine. */
  readonly warmup: number;
}

export function ewmaVolSeries(
  returns: readonly number[],
  lambda: number = RISKMETRICS_LAMBDA,
  warmup = 20,
): EwmaSeries {
  if (lambda <= 0 || lambda >= 1) throw new RangeError('lambda doit être dans ]0,1[');
  if (returns.length <= warmup) {
    throw new RangeError(`série trop courte : ${returns.length} ≤ warmup ${warmup}`);
  }

  // Amorçage par la variance empirique de la fenêtre initiale, qui est ensuite jetée.
  const seed = returns.slice(0, warmup);
  const m = seed.reduce((a, b) => a + b, 0) / warmup;
  let sigma2 = seed.reduce((a, x) => a + (x - m) ** 2, 0) / (warmup - 1);

  const vol: number[] = [];
  for (let t = warmup; t < returns.length; t++) {
    vol.push(Math.sqrt(sigma2));
    const r = returns[t]!;
    sigma2 = lambda * sigma2 + (1 - lambda) * r * r;
  }
  return { vol, warmup };
}

/** Dernière volatilité conditionnelle, c'est-à-dire la prévision pour la période suivante. */
export function ewmaVolNext(
  returns: readonly number[],
  lambda: number = RISKMETRICS_LAMBDA,
  warmup = 20,
): number {
  const { vol } = ewmaVolSeries(returns, lambda, warmup);
  const last = vol[vol.length - 1]!;
  const rLast = returns[returns.length - 1]!;
  return Math.sqrt(lambda * last * last + (1 - lambda) * rLast * rLast);
}
