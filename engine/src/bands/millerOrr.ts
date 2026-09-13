/**
 * Miller-Orr (1966) closed-form solution for cash balance control.
 *
 *   Z* = ∛( 3γσ² / 4r ) + L        H = 3Z* − 2L
 *
 * Assumptions: Brownian net flows **with no drift**, fixed cost γ per rebalance, carry
 * cost r per period, no FX risk, no breach cost.
 *
 * Those assumptions are wrong in our setting — a remittance corridor is structurally
 * unbalanced, and FX risk is precisely what we are trying to steer. Miller-Orr is
 * therefore not the model we use (decision D3). It serves two purposes, and both matter:
 *
 *   1. **warm-starting** the numerical search, which then converges in a few dozen
 *      evaluations instead of a few thousand;
 *   2. **validating** that search: on the degenerate case with no drift and no risk, the
 *      numerical solver must recover the closed form. That is the regression test of the
 *      band engine.
 *
 * A structural property of the project: band width grows as γ^(1/3). Divide the fixed
 * cost of a rebalance by 10⁴ — which is what moving from a correspondent-bank rail to
 * stablecoin settlement does — and the band divides by 10⁴^(1/3) ≈ 21.5. That is the
 * buffer collapse the backtest has to quantify (SPEC §1.2).
 */

export interface Bands {
  /** Lower threshold: below this level, top up to `target`. */
  readonly lower: number;
  /** Return point after a rebalance. */
  readonly target: number;
  /** Upper threshold: above it, sweep the excess back down to `target`. */
  readonly upper: number;
}

export interface MillerOrrInput {
  /** Fixed cost of one rebalance, in currency. */
  readonly gammaFixed: number;
  /** Standard deviation of the net flow per period. */
  readonly flowSigma: number;
  /** Carry cost per period (rate, not percentage). */
  readonly carryRate: number;
  /** Operational or regulatory floor. */
  readonly lower: number;
}

export function millerOrrBands(input: MillerOrrInput): Bands {
  const { gammaFixed, flowSigma, carryRate, lower } = input;
  if (carryRate <= 0) throw new RangeError('carry cost must be strictly positive');
  if (flowSigma <= 0) throw new RangeError('flow volatility must be strictly positive');

  const spread = Math.cbrt((3 * gammaFixed * flowSigma * flowSigma) / (4 * carryRate));
  const target = lower + spread;
  return { lower, target, upper: 3 * target - 2 * lower };
}
