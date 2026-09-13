/** Risk engine tests — SPEC §4.3 and §4.4, decision D4. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../data/src/random.ts';
import { RISK_CURRENCIES, simulateMarket } from '../../data/src/market.ts';
import { cholesky, conditionNumber } from '../src/linalg.ts';
import { ewmaVolSeries } from '../src/risk/ewma.ts';
import { ledoitWolf } from '../src/risk/covariance.ts';
import { conditionalCovariance } from '../src/risk/conditional.ts';
import { standardizedResiduals } from '../src/risk/residuals.ts';
import {
  basisAddOn,
  filteredHistoricalES,
  normalES,
  normalVaR,
  portfolioSigma,
  riskCapital,
  Z_99,
} from '../src/risk/measures.ts';
import { CHI2_99, ljungBox, mean, shuffled, stdev } from '../../data/src/stats.ts';

const MARKET = simulateMarket(4242, 1500);
const NAMES = RISK_CURRENCIES;

function correlation(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db);
}

describe('market simulator — the two properties that matter', () => {
  /**
   * We do NOT test squared-return autocorrelation at one isolated lag.
   *
   * First attempt: acf(1) > 0.05 on squared returns. It failed at 0.039 for EUR — and the
   * test was the thing that was wrong. With Student innovations, kurtosis inflates the
   * autocorrelation denominator and crushes every individual lag, even though the
   * clustering is genuinely there. At 1,500 observations, sampling noise is already
   * 2/√T ≈ 0.052: the threshold sat below the noise.
   *
   * Volatility clustering shows up as serial correlation *persistent across many lags*,
   * not as a spike. The standard test is therefore Ljung-Box on the squares, with a
   * negative control: the same returns shuffled keep exactly the same marginal
   * distribution — same fat tails — but lose their temporal structure. If the test could
   * not tell them apart, it would be detecting fat tails rather than clustering.
   */
  test('volatility clustering: Ljung-Box on the squares, against a shuffled control', () => {
    const rng = new Rng(555);
    for (const c of NAMES) {
      const sq = MARKET.returns[c]!.map((r) => r * r);
      const q = ljungBox(sq, 10);
      assert.ok(
        q > CHI2_99[10]!,
        `${c}: Q = ${q.toFixed(1)} ≤ chi-squared 1% threshold (${CHI2_99[10]})`,
      );

      const control = ljungBox(shuffled(sq, () => rng.nextU32()), 10);
      assert.ok(
        control < q / 5,
        `${c}: the shuffled control (Q = ${control.toFixed(1)}) should collapse against ${q.toFixed(1)}`,
      );
    }
  });

  test('fat tails: return kurtosis exceeds that of a Gaussian', () => {
    for (const c of NAMES) {
      const r = MARKET.returns[c]!;
      const m = mean(r);
      const s = stdev(r);
      const k = mean(r.map((x) => ((x - m) / s) ** 4));
      assert.ok(k > 3.5, `${c}: kurtosis ${k.toFixed(2)}`);
    }
  });
});

describe('EWMA volatility', () => {
  test('tracks the process\'s true conditional volatility', () => {
    for (const c of NAMES) {
      const { vol, warmup } = ewmaVolSeries(MARKET.returns[c]!);
      const truth = MARKET.conditionalVol[c]!.slice(warmup, warmup + vol.length);
      const rho = correlation(vol, truth);
      assert.ok(rho > 0.7, `${c}: EWMA / conditional vol correlation = ${rho.toFixed(3)}`);
    }
  });

  test('recovers the volatility of a homoscedastic series', () => {
    const rng = new Rng(11);
    const trueVol = 0.004;
    const r = Array.from({ length: 4000 }, () => trueVol * rng.normal());
    const { vol } = ewmaVolSeries(r);
    const ratio = mean(vol) / trueVol;
    assert.ok(ratio > 0.9 && ratio < 1.1, `EWMA / true vol ratio = ${ratio.toFixed(3)}`);
  });

  test('refuses a series shorter than the warm-up window', () => {
    assert.throws(() => ewmaVolSeries([0.01, 0.02], 0.94, 20), RangeError);
  });
});

describe('Ledoit-Wolf shrinkage covariance', () => {
  const matrixFrom = (days: number, offset = 0) => {
    const rows: number[][] = [];
    for (let t = offset; t < offset + days; t++) rows.push(NAMES.map((c) => MARKET.returns[c]![t]!));
    return rows;
  };

  test('the estimator stays positive definite', () => {
    for (const T of [8, 20, 60, 500]) {
      const { sigma } = ledoitWolf(matrixFrom(T));
      assert.notEqual(cholesky(sigma), null, `T=${T}: Σ is not positive definite`);
    }
  });

  test('intensity lies in [0,1] and decreases as observations accumulate', () => {
    const small = ledoitWolf(matrixFrom(10)).intensity;
    const large = ledoitWolf(matrixFrom(1000)).intensity;
    for (const d of [small, large]) assert.ok(d >= 0 && d <= 1, `intensity out of bounds: ${d}`);
    assert.ok(small > large, `intensity at T=10 (${small.toFixed(3)}) should exceed T=1000 (${large.toFixed(3)})`);
  });

  test('conditioning improves where it needs to, at low T', () => {
    const { sigma, sample } = ledoitWolf(matrixFrom(6));
    const before = conditionNumber(sample);
    const after = conditionNumber(sigma);
    assert.ok(after < before, `condition number: ${before.toFixed(1)} → ${after.toFixed(1)}`);
  });

  test('at large T, the estimator nearly coincides with the sample covariance', () => {
    const { sigma, sample } = ledoitWolf(matrixFrom(1200));
    for (let i = 0; i < NAMES.length; i++) {
      const rel = Math.abs(sigma[i]![i]! - sample[i]![i]!) / sample[i]![i]!;
      assert.ok(rel < 0.1, `variance ${NAMES[i]}: relative gap ${rel.toFixed(3)}`);
    }
  });
});

describe('risk measures', () => {
  const weights = [4_000_000, -1_500_000, 800_000];
  const rows: number[][] = [];
  for (let t = 0; t < 1000; t++) rows.push(NAMES.map((c) => MARKET.returns[c]![t]!));
  const { sigma } = ledoitWolf(rows);

  test('ES 97.5% ≈ VaR 99% under a Gaussian assumption — the pair FRTB chose', () => {
    const s = portfolioSigma(weights, sigma);
    const es = normalES(s, 1, 0.975);
    const v = normalVaR(s, 1, Z_99);
    const ratio = es / v;
    assert.ok(
      Math.abs(ratio - 1) < 0.01,
      `ES97.5 / VaR99 = ${ratio.toFixed(4)} (expected ≈ 1.005)`,
    );
  });

  test('diversification reduces risk: the portfolio is worth less than the sum of the legs', () => {
    const total = portfolioSigma(weights, sigma);
    const standalone = weights.reduce(
      (a, w, i) => a + Math.abs(w) * Math.sqrt(sigma[i]![i]!),
      0,
    );
    assert.ok(total < standalone, `portfolio σ ${total.toFixed(0)} vs sum ${standalone.toFixed(0)}`);
  });

  test('VaR scales as the square root of time', () => {
    const s = portfolioSigma(weights, sigma);
    const ratio = normalVaR(s, 4) / normalVaR(s, 1);
    assert.ok(Math.abs(ratio - 2) < 1e-9, `ratio ${ratio}`);
  });

  test('the basis add-on is proportional to gross exposure', () => {
    assert.equal(basisAddOn([1_000_000, -1_000_000], 50), 10_000);
  });
});

describe('filtered historical simulation (D4)', () => {
  const weights = [4_000_000, -1_500_000, 800_000];

  /**
   * Comparing an FHS ES against a Gaussian ES built on the *unconditional* covariance
   * would mix two effects: today's volatility level, and tail thickness. A first attempt
   * gave +99% in favour of FHS — almost entirely because the path ends in a turbulent
   * regime, not because of the tails.
   *
   * Both estimators are therefore fed the **same** conditional volatility. Their ratio
   * then measures one thing only, and that is the one we want to test.
   */
  const compare = (returns: Readonly<Record<string, readonly number[]>>) => {
    const { residuals, currentVol } = standardizedResiduals(returns, NAMES);
    const { sigma } = conditionalCovariance(residuals, currentVol);
    const parametric = normalES(portfolioSigma(weights, sigma), 1, 0.975);
    const fhs = filteredHistoricalES({
      residuals,
      currentVol,
      weights,
      horizonDays: 1,
      alpha: 0.975,
    });
    return { parametric, fhs, ratio: fhs.es / parametric };
  };

  test('on Gaussian data, FHS recovers the normal ES — no systematic bias', () => {
    const rng = new Rng(2026);
    const vols = [0.005, 0.006, 0.011];
    const returns: Record<string, number[]> = {};
    NAMES.forEach((c, i) => {
      returns[c] = Array.from({ length: 4000 }, () => vols[i]! * rng.normal());
    });
    const { ratio } = compare(returns);
    assert.ok(ratio > 0.9 && ratio < 1.1, `FHS / normal ES on Gaussian data = ${ratio.toFixed(3)}`);
  });

  test('on fat-tailed data, FHS exceeds the normal ES — this is the point of D4', () => {
    const { ratio, fhs, parametric } = compare(MARKET.returns);
    assert.ok(
      ratio > 1.05,
      `at identical conditional volatility, FHS ${fhs.es.toFixed(0)} vs normal ` +
        `${parametric.toFixed(0)} — ratio ${ratio.toFixed(3)}, expected > 1.05`,
    );
    assert.ok(ratio < 2, `ratio ${ratio.toFixed(3)} implausible: check the residual scaling`);
  });

  test('the conditional covariance does capture today\'s volatility level', () => {
    const { residuals, currentVol } = standardizedResiduals(MARKET.returns, NAMES);
    const { sigma, correlation } = conditionalCovariance(residuals, currentVol);
    for (let i = 0; i < NAMES.length; i++) {
      assert.ok(
        Math.abs(Math.sqrt(sigma[i]![i]!) - currentVol[i]!) < 1e-9,
        `${NAMES[i]}: the diagonal of Σ must return exactly the current σ`,
      );
      assert.ok(Math.abs(correlation[i]![i]! - 1) < 1e-9, 'the diagonal of R is not unit');
    }
    assert.notEqual(cholesky(sigma), null, 'the conditional Σ is not positive definite');
  });

  test('ES always dominates VaR at the same level', () => {
    const { residuals, currentVol } = standardizedResiduals(MARKET.returns, NAMES);
    const fhs = filteredHistoricalES({
      residuals,
      currentVol,
      weights,
      horizonDays: 1,
      alpha: 0.975,
    });
    assert.ok(fhs.es >= fhs.var, `ES ${fhs.es.toFixed(0)} < VaR ${fhs.var.toFixed(0)}`);
  });

  test('risk capital aggregates ES and the basis add-on', () => {
    const { residuals, currentVol } = standardizedResiduals(MARKET.returns, NAMES);
    const { sigma } = conditionalCovariance(residuals, currentVol);
    const rc = riskCapital({
      weights,
      sigma,
      horizonDays: 1,
      fhs: { residuals, currentVol, weights, horizonDays: 1, alpha: 0.975 },
      basisHaircutBps: 50,
    });
    assert.ok(rc.es975Fhs !== null);
    assert.ok(Math.abs(rc.total - (rc.es975Fhs! + rc.basis)) < 1e-6);
    assert.ok(rc.basis > 0);
  });
});
