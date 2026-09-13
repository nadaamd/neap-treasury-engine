/**
 * Seasonality profiles for the payment arrival intensity.
 *
 * Central invariant: **every profile has mean 1 over its cycle**. The calibrated daily
 * volume is therefore preserved whatever the shape of the profiles — the shape can be
 * adjusted without recalibrating the intensity. This invariant is tested
 * (data/test/seasonality.test.ts).
 */

function normalize(raw: readonly number[]): readonly number[] {
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  return raw.map((x) => x / mean);
}

/**
 * Hourly profile (UTC), bimodal: overnight trough, morning ramp, mid-morning peak, second
 * peak in early afternoon, evening decay.
 * The typical shape of retail and SME payments in the euro area.
 */
const HOUR_RAW = [
  0.15, 0.10, 0.08, 0.07, 0.08, 0.12, 0.25, 0.55,
  1.10, 1.60, 1.85, 1.90, 1.55, 1.45, 1.70, 1.75,
  1.65, 1.50, 1.30, 1.05, 0.85, 0.65, 0.45, 0.28,
];
export const HOUR_PROFILE = normalize(HOUR_RAW);

/**
 * Weekly profile, indexed like `Date.getUTCDay()` (0 = Sunday).
 * Calibrated for a weekend trough of roughly −60% against the weekday level
 * (SPEC §17.1), which is the checkpoint under test.
 */
const DOW_RAW = [0.45, 1.25, 1.30, 1.30, 1.30, 1.35, 0.60];
export const DOW_PROFILE = normalize(DOW_RAW);

/**
 * Day-of-month profile (index 0 = the 1st).
 * Two payroll effects: a sharp peak on the 1st, a high plateau at month end.
 * Months shorter than 31 days do not use the last entries, which introduces a residual
 * bias of a few percent on the annual mean — bounded by the test.
 */
const DOM_RAW = [
  1.90, 1.45, 1.30, 0.95, 0.85, 0.82, 0.80, 0.80, 0.82, 0.85,
  0.88, 0.90, 0.92, 1.00, 1.15, 1.00, 0.90, 0.86, 0.84, 0.84,
  0.86, 0.90, 0.98, 1.10, 1.30, 1.35, 1.38, 1.40, 1.40, 1.38, 1.35,
];
export const DOM_PROFILE = normalize(DOM_RAW);

/** Intensity multiplier for a given instant. */
export function seasonalFactor(ts: number): number {
  const d = new Date(ts);
  return (
    HOUR_PROFILE[d.getUTCHours()]! *
    DOW_PROFILE[d.getUTCDay()]! *
    DOM_PROFILE[d.getUTCDate() - 1]!
  );
}
