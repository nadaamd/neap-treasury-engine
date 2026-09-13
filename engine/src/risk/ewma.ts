/**
 * EWMA conditional volatility (RiskMetrics).
 *
 *   σ²_t = λ σ²_{t−1} + (1 − λ) r²_{t−1}
 *
 * λ = 0.94 is the RiskMetrics value for daily data. Choosing a decaying-memory
 * estimator over a rolling variance is not cosmetic: FX returns exhibit volatility
 * clustering, and a rolling window responds to it with a lag equal to half its width —
 * then drops abruptly once the shock leaves the window.
 *
 * No-lookahead discipline: `σ_t` only uses returns strictly earlier than `t`. The
 * warm-up window is returned separately and must be excluded from every downstream
 * computation (SPEC §18.1).
 */

export const RISKMETRICS_LAMBDA = 0.94;

export interface EwmaSeries {
  /** σ_t for t ∈ [warmup, T) — conditional volatility known *before* observing r_t. */
  readonly vol: number[];
  /** Index of the first element of `vol` within the original return series. */
  readonly warmup: number;
}

export function ewmaVolSeries(
  returns: readonly number[],
  lambda: number = RISKMETRICS_LAMBDA,
  warmup = 20,
): EwmaSeries {
  if (lambda <= 0 || lambda >= 1) throw new RangeError('lambda must lie in ]0,1[');
  if (returns.length <= warmup) {
    throw new RangeError(`series too short: ${returns.length} ≤ warmup ${warmup}`);
  }

  // Seeded with the sample variance of the initial window, which is then discarded.
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

/** Last conditional volatility, i.e. the forecast for the next period. */
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
