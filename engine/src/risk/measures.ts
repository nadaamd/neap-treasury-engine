/**
 * Market risk measures — decision D4.
 *
 * Three estimators are provided and compared, because the gap between them *is* the
 * interesting result:
 *
 *   • Normal VaR  — the language of the business, used for display;
 *   • Normal ES   — coherent, but assumes normality;
 *   • FHS ES      — filtered historical simulation, the one the decision uses.
 *
 * Why 97.5% for ES and 99% for VaR? Because under a Gaussian assumption
 * ES_97.5 ≈ VaR_99 (2.338 σ against 2.326 σ). The Basel committee picked that pair in
 * FRTB precisely so that moving from VaR to ES would not change the capital level on
 * normal distributions — while making the measure sensitive to what happens *beyond*
 * the quantile. The gap between the two therefore measures tail thickness, and nothing
 * else. This module has a test for exactly that.
 */

import { quadForm } from '../linalg.ts';
import type { Matrix, Vector } from '../linalg.ts';

/** Normal quantile at 99%. */
export const Z_99 = 2.3263478740408408;
/** Normal quantile at 97.5%. */
export const Z_975 = 1.959963984540054;

function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Gaussian ES multiplier: φ(z_α) / (1 − α). */
export function normalEsFactor(alpha: number, z: number): number {
  return normalPdf(z) / (1 - alpha);
}

/** Portfolio volatility: √(wᵀ Σ w). */
export function portfolioSigma(weights: Vector, sigma: Matrix): number {
  const v = quadForm(weights, sigma);
  return Math.sqrt(Math.max(v, 0));
}

/** Gaussian VaR, as an amount, over a `horizonDays`-day horizon. */
export function normalVaR(sigmaP: number, horizonDays: number, z: number = Z_99): number {
  return z * sigmaP * Math.sqrt(horizonDays);
}

/** Gaussian ES, as an amount. */
export function normalES(sigmaP: number, horizonDays: number, alpha = 0.975): number {
  const z = alpha === 0.975 ? Z_975 : Z_99;
  return normalEsFactor(alpha, z) * sigmaP * Math.sqrt(horizonDays);
}

export interface FhsInput {
  /**
   * Standardised residuals z_{t,i} = r_{t,i} / σ_{t,i}, a T × n matrix.
   * Cross-sectional vectors are kept as they are: that is what preserves the empirical
   * correlation and the tail dependence between currencies. Resampling each currency
   * independently would destroy exactly the information that matters.
   */
  readonly residuals: readonly (readonly number[])[];
  /** Current conditional volatility per currency. */
  readonly currentVol: Vector;
  /** Signed exposure per currency, in numeraire. */
  readonly weights: Vector;
  readonly horizonDays: number;
  readonly alpha: number;
}

export interface FhsResult {
  readonly es: number;
  readonly var: number;
  /** Number of tail scenarios actually averaged. */
  readonly tailCount: number;
}

/**
 * Filtered historical simulation.
 *
 * Filtering means dividing past returns by the volatility that prevailed at the time,
 * then multiplying back by today's volatility. So the *shape* of the historical
 * distribution is reused — its tails, its skew, its cross-sectional dependence —
 * without importing its volatility level, which is stale.
 *
 * That is what separates FHS from raw historical simulation, which underestimates risk
 * after a quiet period and overestimates it after a crisis.
 */
export function filteredHistoricalES(input: FhsInput): FhsResult {
  const { residuals, currentVol, weights, horizonDays, alpha } = input;
  const scale = Math.sqrt(horizonDays);
  const losses: number[] = [];

  for (const z of residuals) {
    let pnl = 0;
    for (let i = 0; i < weights.length; i++) {
      pnl += weights[i]! * currentVol[i]! * z[i]! * scale;
    }
    losses.push(-pnl);
  }

  losses.sort((a, b) => b - a); // losses in decreasing order
  const tailCount = Math.max(1, Math.ceil(losses.length * (1 - alpha)));
  const tail = losses.slice(0, tailCount);
  const es = tail.reduce((a, b) => a + b, 0) / tailCount;
  return { es, var: losses[tailCount - 1]!, tailCount };
}

/**
 * Stablecoin basis risk add-on — SPEC §1.5.
 *
 * Hedging a EUR exposure with EURC leaves residual risk: peg break, issuer default,
 * redemption liquidity. That risk is structurally invisible in a short history — the peg
 * holds until the day it does not. So it is handled with an explicit flat add-on rather
 * than by pretending it does not exist.
 */
export function basisAddOn(exposures: Vector, haircutBps: number): number {
  const h = haircutBps / 10_000;
  return exposures.reduce((a, e) => a + Math.abs(e), 0) * h;
}

export interface RiskCapitalInput {
  readonly weights: Vector;
  readonly sigma: Matrix;
  readonly horizonDays: number;
  readonly fhs?: FhsInput;
  readonly basisHaircutBps: number;
}

export interface RiskCapital {
  readonly sigmaP: number;
  readonly var99Normal: number;
  readonly es975Normal: number;
  readonly es975Fhs: number | null;
  readonly basis: number;
  /** Risk capital used by the decision: ES (FHS when available) + basis. */
  readonly total: number;
}

export function riskCapital(input: RiskCapitalInput): RiskCapital {
  const sigmaP = portfolioSigma(input.weights, input.sigma);
  const var99Normal = normalVaR(sigmaP, input.horizonDays, Z_99);
  const es975Normal = normalES(sigmaP, input.horizonDays, 0.975);
  const es975Fhs = input.fhs ? filteredHistoricalES(input.fhs).es : null;
  const basis = basisAddOn(input.weights, input.basisHaircutBps);
  const es = es975Fhs ?? es975Normal;
  return { sigmaP, var99Normal, es975Normal, es975Fhs, basis, total: es + basis };
}
