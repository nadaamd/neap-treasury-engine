/**
 * Left-tail model of the net flow distribution.
 *
 * ─── Why this module exists ───────────────────────────────────────────────────
 * The first version of the objective charged the breach cost by **counting** the times
 * the balance went below zero in simulation. The solver turned out to be insensitive to
 * that cost: anywhere between $20k and $5M per breach, the optimum did not move by a
 * dollar.
 *
 * The cause is not a bug but a resolution limit. Near the optimum, the per-period breach
 * probability is of the order of 10⁻⁵ — you get that from equalising marginal costs:
 * lowering the buffer by $100k saves $0.17 of carry per period, which only pays if the
 * added breach probability stays under 10⁻⁵ at a cost of $20k. But 300 paths × 400
 * periods is only 120,000 draws: a 10⁻⁵ event essentially never shows up there. The
 * measured term was zero everywhere, and so was its gradient.
 *
 * **A rare-event cost must be priced analytically, not counted.** So the indicator is
 * replaced by an expectation: each period charges `breach_cost × P(flow < −balance)`,
 * which is a smooth, strictly positive function of the balance — and therefore usable by
 * the optimiser.
 *
 * ─── The model ────────────────────────────────────────────────────────────────
 * Empirical distribution function over the observed range, extended by an exponential
 * tail beyond the observed minimum. This is the first-order peaks-over-threshold
 * approximation from extreme value theory: beyond a low enough threshold, excesses
 * approximately follow a generalised Pareto distribution, whose ξ = 0 case is the
 * exponential. We assume that ξ = 0 rather than estimating it on a sample that could not
 * support the estimate.
 */

export interface TailModel {
  /** P(X < x). */
  probBelow(x: number): number;
  /** Threshold beyond which the exponential extrapolation takes over. */
  readonly threshold: number;
  /** Scale parameter of the exponential tail. */
  readonly scale: number;
}

export function empiricalLeftTail(
  history: readonly number[],
  tailFraction = 0.05,
): TailModel {
  if (history.length < 20) throw new RangeError('history too short to estimate a tail');
  const sorted = history.slice().sort((a, b) => a - b);
  const n = sorted.length;

  const k = Math.max(2, Math.floor(n * tailFraction));
  const threshold = sorted[k - 1]!;
  const f0 = k / n;

  // Mean excess below the threshold: maximum-likelihood estimator of the exponential
  // scale.
  let excess = 0;
  for (let i = 0; i < k; i++) excess += threshold - sorted[i]!;
  const scale = Math.max(excess / k, Number.EPSILON);

  const probBelow = (x: number): number => {
    if (x <= threshold) {
      return f0 * Math.exp(-(threshold - x) / scale);
    }
    if (x >= sorted[n - 1]!) return 1;
    // Linear interpolation on the empirical distribution function.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo / n;
  };

  return { probBelow, threshold, scale };
}
