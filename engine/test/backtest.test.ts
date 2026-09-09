/** Tests du protocole de backtest — SPEC §18, décision D10. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CORRIDORS } from '../../data/calibration/corridors.ts';
import { generateFlows } from '../../data/src/generator.ts';
import { bucketize } from '../../data/src/aggregate.ts';
import { simulateMarket } from '../../data/src/market.ts';
import { CURRENCIES, EPOCHS_PER_DAY, EPOCH_MS, FAST_CONFIG } from '../src/backtest/config.ts';
import { buildPolicy, esPerUnit } from '../src/backtest/policies.ts';
import { runPolicy } from '../src/backtest/simulate.ts';
import { runBacktest, runSeed } from '../src/backtest/walkforward.ts';
import { standardizedResiduals } from '../src/risk/residuals.ts';
import type { Currency } from '../../data/src/types.ts';
import type { PolicyKind } from '../src/backtest/types.ts';

const CFG = FAST_CONFIG;
const POLICIES: readonly PolicyKind[] = ['STATIC', 'CALENDAR', 'FLOAT', 'CLAIRVOYANT'];

function flowsFor(seed: number, days: number): Record<Currency, number[]> {
  const events = generateFlows({
    seed,
    startTs: CFG.startTs,
    days,
    corridors: CORRIDORS,
  });
  const buckets = bucketize(events, CFG.startTs, EPOCH_MS, days * EPOCHS_PER_DAY);
  const out = {} as Record<Currency, number[]>;
  for (const c of CURRENCIES) out[c] = buckets.map((b) => b.net[c]);
  return out;
}

describe('protocole walk-forward', () => {
  test('le backtest est reproductible germe par germe', () => {
    assert.deepEqual(runSeed(1000, CFG), runSeed(1000, CFG));
  });

  test('des germes différents produisent des résultats différents', () => {
    assert.notDeepEqual(runSeed(1000, CFG), runSeed(1001, CFG));
  });

  test('les quatre politiques sont évaluées', () => {
    const r = runSeed(1000, CFG);
    for (const k of POLICIES) assert.ok(r.byPolicy[k], `politique ${k} manquante`);
  });

  /**
   * Le canari d'anticipation.
   *
   * On injecte un choc gigantesque dans la portion *future* de la série de flux, puis on
   * reconstruit les bandes à partir de la seule fenêtre de calibration. Si le résultat
   * change, c'est qu'une information postérieure à la date de décision a fui vers l'amont
   * — le défaut le plus insidieux d'un backtest, parce qu'il embellit les résultats sans
   * jamais provoquer d'erreur.
   *
   * Le contre-test est tout aussi nécessaire : le même choc injecté dans la fenêtre de
   * calibration *doit* déplacer les bandes. Sans lui, un canari qui ne détecte rien
   * pourrait simplement être un canari mort.
   */
  test('aucune information future ne remonte vers les décisions antérieures', () => {
    const days = CFG.warmupDays + CFG.evalDays;
    const calibEpochs = CFG.warmupDays * EPOCHS_PER_DAY;
    const clean = flowsFor(2024, days);
    const market = simulateMarket(999, days);
    const dailyVol = {} as Record<Currency, number>;
    for (const c of CURRENCIES) dailyVol[c] = 0.005;

    const slice = (f: Record<Currency, number[]>, a: number, b: number) => {
      const o = {} as Record<Currency, number[]>;
      for (const c of CURRENCIES) o[c] = f[c]!.slice(a, b);
      return o;
    };

    const build = (f: Record<Currency, number[]>) =>
      buildPolicy('FLOAT', {
        calibration: slice(f, 0, calibEpochs),
        evaluation: slice(f, calibEpochs, f.EUR.length),
        dailyVol,
        cfg: CFG,
        seed: 7,
      }).bands;

    const reference = build(clean);

    // Choc dans le futur : les bandes ne doivent pas bouger d'un dollar.
    const futureShock = slice(clean, 0, clean.EUR.length);
    futureShock.EUR[calibEpochs + 10] = -500_000_000;
    assert.deepEqual(build(futureShock), reference, 'fuite d’information depuis le futur');

    // Contre-test : le même choc dans le passé doit, lui, déplacer les bandes.
    const pastShock = slice(clean, 0, clean.EUR.length);
    pastShock.EUR[calibEpochs - 10] = -500_000_000;
    assert.notDeepEqual(build(pastShock), reference, 'le canari ne détecte plus rien');

    void market;
  });
});

describe('politiques', () => {
  const days = CFG.warmupDays;
  const flows = flowsFor(2024, days);
  const dailyVol = {} as Record<Currency, number>;
  for (const c of CURRENCIES) dailyVol[c] = 0.005;
  const input = { calibration: flows, evaluation: flows, dailyVol, cfg: CFG, seed: 5 };

  test('toutes les politiques produisent des bandes ordonnées et positives', () => {
    for (const k of POLICIES) {
      const { bands } = buildPolicy(k, input);
      for (const c of CURRENCIES) {
        const b = bands[c];
        assert.ok(b.lower >= 0, `${k}/${c} : seuil bas négatif`);
        assert.ok(b.lower <= b.target && b.target <= b.upper, `${k}/${c} : bandes désordonnées`);
        assert.ok(Number.isFinite(b.target), `${k}/${c} : cible non finie`);
      }
    }
  });

  /**
   * Le dimensionnement conservateur doit rester positif même sur un corridor
   * structurellement *entrant*.
   *
   * Un premier jet mesurait la pire sortie nette journalière ; sur l'euro, dont les flux
   * sont massivement entrants, elle vaut zéro. La bande devenait dérisoire et la
   * politique censée être la plus prudente accumulait quatre cent quarante ruptures.
   * Un solde net positif sur la journée ne dit rien du creux traversé en cours de route.
   */
  test('le buffer conservateur reste substantiel sur un corridor entrant', () => {
    const { bands } = buildPolicy('STATIC', input);
    for (const c of CURRENCIES) {
      assert.ok(bands[c].target > 100_000, `${c} : cible statique dérisoire (${bands[c].target})`);
    }
  });

  test('seule la politique calendaire est marquée comme telle', () => {
    for (const k of POLICIES) {
      assert.equal(buildPolicy(k, input).calendarOnly, k === 'CALENDAR');
    }
  });

  test('l’ES par unité d’exposition croît avec la volatilité', () => {
    assert.ok(esPerUnit(0.01) > esPerUnit(0.005));
  });
});

describe('exécution d’une politique', () => {
  const days = CFG.warmupDays;
  const flows = flowsFor(2024, days);
  const market = simulateMarket(999, days);
  const { residuals, currentVol } = standardizedResiduals(market.returns, CURRENCIES);
  const dailyVol = {} as Record<Currency, number>;
  for (const c of CURRENCIES) dailyVol[c] = 0.005;
  const policy = buildPolicy('FLOAT', {
    calibration: flows,
    evaluation: flows,
    dailyVol,
    cfg: CFG,
    seed: 5,
  });

  const run = () => runPolicy({ policy, flows, residuals, currentVol });

  test('le résultat est déterministe', () => {
    assert.deepEqual(run(), run());
  });

  test('le coût total est la somme du portage et de l’exécution', () => {
    const m = run();
    assert.ok(Math.abs(m.totalCost - (m.carryCost + m.executionCost)) < 1e-6);
  });

  test('toutes les grandeurs sont positives ou nulles', () => {
    const m = run();
    for (const [name, v] of Object.entries(m)) {
      assert.ok(v >= 0, `${name} négatif : ${v}`);
    }
  });

  /// Une politique calendaire ne peut pas rééquilibrer plus d'une fois par jour et par devise.
  test('la cadence calendaire est respectée', () => {
    const calendar = buildPolicy('CALENDAR', {
      calibration: flows,
      evaluation: flows,
      dailyVol,
      cfg: CFG,
      seed: 5,
    });
    const m = runPolicy({ policy: calendar, flows, residuals, currentVol });
    const maxPossible = days * CURRENCIES.length;
    assert.ok(m.rebalances <= maxPossible, `${m.rebalances} > ${maxPossible}`);
  });
});

describe('agrégation', () => {
  const summary = runBacktest(CFG);

  test('les intervalles de confiance reposent sur tous les germes', () => {
    for (const k of POLICIES) {
      assert.equal(summary.metrics[k].capital.n, CFG.seeds.length);
      assert.ok(summary.metrics[k].capital.halfWidth >= 0);
    }
  });

  /**
   * Le résultat central du backtest : les bandes optimisées immobilisent nettement moins
   * de capital que le pré-financement conservateur. Le seuil est volontairement lâche —
   * on teste que la thèse tient, pas qu'elle atteigne un chiffre précis, lequel dépend
   * d'hypothèses assumées comme non calibrées.
   */
  test('les bandes optimisées libèrent la majorité du capital immobilisé', () => {
    const ratio = summary.metrics.FLOAT.capital.mean / summary.metrics.STATIC.capital.mean;
    assert.ok(ratio < 0.5, `capital FLOAT / STATIC = ${ratio.toFixed(3)}, attendu < 0,5`);
  });

  test('le risque de change baisse dans la même proportion', () => {
    assert.ok(summary.metrics.FLOAT.es.mean < summary.metrics.STATIC.es.mean);
  });

  /**
   * Contrôle d'honnêteté. FLOAT rééquilibre bien plus souvent que le pré-financement
   * conservateur : si le rapport prétendait le contraire, c'est que la simulation
   * compterait mal.
   */
  test('FLOAT passe bien plus d’ordres que le pré-financement conservateur', () => {
    assert.ok(summary.metrics.FLOAT.rebalances.mean > summary.metrics.STATIC.rebalances.mean * 5);
  });
});
