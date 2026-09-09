/** Tests du moteur de risque — SPEC §4.3 et §4.4, décision D4. */

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

describe('simulateur de marché — les deux propriétés qui comptent', () => {
  /**
   * On ne teste PAS l'autocorrélation des carrés à un retard isolé.
   *
   * Premier essai : acf(1) > 0.05 sur les rendements au carré. Échec à 0.039 pour l'EUR —
   * et c'est le test qui avait tort. Avec des innovations de Student, la kurtosis gonfle
   * le dénominateur de l'autocorrélation et écrase chaque retard pris isolément, alors
   * même que le groupement est bien présent. À 1 500 observations, le bruit
   * d'échantillonnage vaut déjà 2/√T ≈ 0,052 : le seuil était sous le bruit.
   *
   * Le groupement de volatilité se manifeste comme une corrélation sérielle *persistante
   * sur de nombreux retards*, pas comme un pic. Le test standard est donc Ljung-Box sur
   * les carrés, avec un contrôle négatif : les mêmes rendements mélangés conservent
   * exactement la même distribution marginale — mêmes queues épaisses — mais perdent
   * leur structure temporelle. Si le test ne distinguait pas les deux, il détecterait
   * les queues épaisses et non le groupement.
   */
  test('groupement de volatilité : Ljung-Box sur les carrés, contre contrôle mélangé', () => {
    const rng = new Rng(555);
    for (const c of NAMES) {
      const sq = MARKET.returns[c]!.map((r) => r * r);
      const q = ljungBox(sq, 10);
      assert.ok(
        q > CHI2_99[10]!,
        `${c} : Q = ${q.toFixed(1)} ≤ seuil khi-deux 1 % (${CHI2_99[10]})`,
      );

      const control = ljungBox(shuffled(sq, () => rng.nextU32()), 10);
      assert.ok(
        control < q / 5,
        `${c} : le contrôle mélangé (Q = ${control.toFixed(1)}) devrait s'effondrer face à ${q.toFixed(1)}`,
      );
    }
  });

  test('queues épaisses : la kurtosis des rendements dépasse celle d’une gaussienne', () => {
    for (const c of NAMES) {
      const r = MARKET.returns[c]!;
      const m = mean(r);
      const s = stdev(r);
      const k = mean(r.map((x) => ((x - m) / s) ** 4));
      assert.ok(k > 3.5, `${c} : kurtosis ${k.toFixed(2)}`);
    }
  });
});

describe('volatilité EWMA', () => {
  test('suit la volatilité conditionnelle réelle du processus', () => {
    for (const c of NAMES) {
      const { vol, warmup } = ewmaVolSeries(MARKET.returns[c]!);
      const truth = MARKET.conditionalVol[c]!.slice(warmup, warmup + vol.length);
      const rho = correlation(vol, truth);
      assert.ok(rho > 0.7, `${c} : corrélation EWMA / vol conditionnelle = ${rho.toFixed(3)}`);
    }
  });

  test('retrouve la volatilité d’une série homoscédastique', () => {
    const rng = new Rng(11);
    const trueVol = 0.004;
    const r = Array.from({ length: 4000 }, () => trueVol * rng.normal());
    const { vol } = ewmaVolSeries(r);
    const ratio = mean(vol) / trueVol;
    assert.ok(ratio > 0.9 && ratio < 1.1, `ratio EWMA / vol vraie = ${ratio.toFixed(3)}`);
  });

  test('refuse une série plus courte que la fenêtre d’amorçage', () => {
    assert.throws(() => ewmaVolSeries([0.01, 0.02], 0.94, 20), RangeError);
  });
});

describe('covariance à shrinkage de Ledoit-Wolf', () => {
  const matrixFrom = (days: number, offset = 0) => {
    const rows: number[][] = [];
    for (let t = offset; t < offset + days; t++) rows.push(NAMES.map((c) => MARKET.returns[c]![t]!));
    return rows;
  };

  test('l’estimateur reste défini positif', () => {
    for (const T of [8, 20, 60, 500]) {
      const { sigma } = ledoitWolf(matrixFrom(T));
      assert.notEqual(cholesky(sigma), null, `T=${T} : Σ non définie positive`);
    }
  });

  test('l’intensité est dans [0,1] et décroît quand les observations s’accumulent', () => {
    const small = ledoitWolf(matrixFrom(10)).intensity;
    const large = ledoitWolf(matrixFrom(1000)).intensity;
    for (const d of [small, large]) assert.ok(d >= 0 && d <= 1, `intensité hors bornes : ${d}`);
    assert.ok(small > large, `intensité T=10 (${small.toFixed(3)}) devrait dépasser T=1000 (${large.toFixed(3)})`);
  });

  test('le conditionnement s’améliore là où c’est nécessaire, à faible T', () => {
    const { sigma, sample } = ledoitWolf(matrixFrom(6));
    const before = conditionNumber(sample);
    const after = conditionNumber(sigma);
    assert.ok(after < before, `conditionnement : ${before.toFixed(1)} → ${after.toFixed(1)}`);
  });

  test('à grand T, l’estimateur se confond presque avec l’empirique', () => {
    const { sigma, sample } = ledoitWolf(matrixFrom(1200));
    for (let i = 0; i < NAMES.length; i++) {
      const rel = Math.abs(sigma[i]![i]! - sample[i]![i]!) / sample[i]![i]!;
      assert.ok(rel < 0.1, `variance ${NAMES[i]} : écart relatif ${rel.toFixed(3)}`);
    }
  });
});

describe('mesures de risque', () => {
  const weights = [4_000_000, -1_500_000, 800_000];
  const rows: number[][] = [];
  for (let t = 0; t < 1000; t++) rows.push(NAMES.map((c) => MARKET.returns[c]![t]!));
  const { sigma } = ledoitWolf(rows);

  test('ES 97,5 % ≈ VaR 99 % sous hypothèse gaussienne — le couple retenu par FRTB', () => {
    const s = portfolioSigma(weights, sigma);
    const es = normalES(s, 1, 0.975);
    const v = normalVaR(s, 1, Z_99);
    const ratio = es / v;
    assert.ok(
      Math.abs(ratio - 1) < 0.01,
      `ES97,5 / VaR99 = ${ratio.toFixed(4)} (attendu ≈ 1,005)`,
    );
  });

  test('la diversification réduit le risque : le portefeuille vaut moins que la somme des jambes', () => {
    const total = portfolioSigma(weights, sigma);
    const standalone = weights.reduce(
      (a, w, i) => a + Math.abs(w) * Math.sqrt(sigma[i]![i]!),
      0,
    );
    assert.ok(total < standalone, `σ portefeuille ${total.toFixed(0)} vs somme ${standalone.toFixed(0)}`);
  });

  test('la VaR croît en racine du temps', () => {
    const s = portfolioSigma(weights, sigma);
    const ratio = normalVaR(s, 4) / normalVaR(s, 1);
    assert.ok(Math.abs(ratio - 2) < 1e-9, `ratio ${ratio}`);
  });

  test('la majoration de base est proportionnelle à l’exposition brute', () => {
    assert.equal(basisAddOn([1_000_000, -1_000_000], 50), 10_000);
  });
});

describe('simulation historique filtrée (D4)', () => {
  const weights = [4_000_000, -1_500_000, 800_000];

  /**
   * Comparer une ES par FHS à une ES gaussienne bâtie sur la covariance
   * *inconditionnelle* mélangerait deux effets : le niveau de volatilité du jour, et
   * l'épaisseur des queues. Un premier jet donnait +99 % en faveur de la FHS — presque
   * entièrement dû au fait que la trajectoire se termine en régime agité, pas aux queues.
   *
   * Les deux estimateurs sont donc alimentés par la **même** volatilité conditionnelle.
   * Leur rapport ne mesure alors plus qu'une chose, et c'est la seule qu'on veut tester.
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

  test('sur données gaussiennes, la FHS retrouve l’ES normale — pas de biais systématique', () => {
    const rng = new Rng(2026);
    const vols = [0.005, 0.006, 0.011];
    const returns: Record<string, number[]> = {};
    NAMES.forEach((c, i) => {
      returns[c] = Array.from({ length: 4000 }, () => vols[i]! * rng.normal());
    });
    const { ratio } = compare(returns);
    assert.ok(ratio > 0.9 && ratio < 1.1, `FHS / ES normale sur gaussienne = ${ratio.toFixed(3)}`);
  });

  test('sur données à queues épaisses, la FHS majore l’ES normale — c’est la raison d’être de D4', () => {
    const { ratio, fhs, parametric } = compare(MARKET.returns);
    assert.ok(
      ratio > 1.05,
      `à volatilité conditionnelle identique, FHS ${fhs.es.toFixed(0)} vs normale ` +
        `${parametric.toFixed(0)} — ratio ${ratio.toFixed(3)}, attendu > 1,05`,
    );
    assert.ok(ratio < 2, `ratio ${ratio.toFixed(3)} implausible : vérifier l'échelle des résidus`);
  });

  test('la covariance conditionnelle capte bien le niveau de volatilité du jour', () => {
    const { residuals, currentVol } = standardizedResiduals(MARKET.returns, NAMES);
    const { sigma, correlation } = conditionalCovariance(residuals, currentVol);
    for (let i = 0; i < NAMES.length; i++) {
      assert.ok(
        Math.abs(Math.sqrt(sigma[i]![i]!) - currentVol[i]!) < 1e-9,
        `${NAMES[i]} : la diagonale de Σ doit rendre exactement σ courant`,
      );
      assert.ok(Math.abs(correlation[i]![i]! - 1) < 1e-9, 'diagonale de R non unitaire');
    }
    assert.notEqual(cholesky(sigma), null, 'Σ conditionnelle non définie positive');
  });

  test('l’ES domine toujours la VaR au même seuil', () => {
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

  test('le capital de risque agrège l’ES et la majoration de base', () => {
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
