/** Tests du solveur de bandes — SPEC §4.1 et §4.2, décision D3. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CORRIDORS } from '../../data/calibration/corridors.ts';
import { generateFlows } from '../../data/src/generator.ts';
import { bucketize } from '../../data/src/aggregate.ts';
import { mean, stdev } from '../../data/src/stats.ts';
import { millerOrrBands } from '../src/bands/millerOrr.ts';
import { bootstrapPaths, evaluatePolicy, executionCost } from '../src/bands/simulate.ts';
import { empiricalLeftTail } from '../src/bands/tail.ts';
import type { CostParams } from '../src/bands/simulate.ts';
import { solveBands } from '../src/bands/solver.ts';

const START = Date.UTC(2025, 0, 1);
const EPOCH_MS = 15 * 60 * 1000;
const EPOCHS_PER_DAY = 96;
const DAYS = 180;

const events = generateFlows({ seed: 7, startTs: START, days: DAYS, corridors: CORRIDORS });
const rawFlows = bucketize(events, START, EPOCH_MS, DAYS * EPOCHS_PER_DAY).map((b) => b.net.EUR);
const drift = mean(rawFlows);
/** Série sans dérive : c'est le cadre d'hypothèses de Miller-Orr. */
const flatFlows = rawFlows.map((x) => x - drift);
const FLOW_SIGMA = stdev(flatFlows);
const CARRY = 0.06 / 365 / EPOCHS_PER_DAY;

const PATHS = bootstrapPaths(flatFlows, 300, 400, 99);
const TAIL = empiricalLeftTail(flatFlows);
const DRIFTED_PATHS = bootstrapPaths(rawFlows, 300, 400, 99);

const baseCosts: CostParams = {
  gammaFixed: 2,
  spreadBps: 0,
  etaImpact: 0,
  depth: 5_000_000,
  carryRate: CARRY,
  kappa: 0,
  esPerUnit: 0,
  breachCost: 50_000,
};

function solve(costs: Partial<CostParams>, paths = PATHS) {
  const merged = { ...baseCosts, ...costs };
  const mo = millerOrrBands({
    gammaFixed: merged.gammaFixed,
    flowSigma: FLOW_SIGMA,
    carryRate: merged.carryRate,
    lower: 0,
  });
  const spread = mo.target - mo.lower;
  return {
    analytic: mo,
    result: solveBands({
      paths,
      costs: merged,
      tail: TAIL,
      warmStart: mo,
      floor: 0,
      initialStep: spread / 2,
      tolerance: spread / 512,
      maxEvaluations: 8000,
    }),
  };
}

describe('Miller-Orr analytique', () => {
  const mo = millerOrrBands({ gammaFixed: 25, flowSigma: FLOW_SIGMA, carryRate: CARRY, lower: 0 });

  test('l’identité H = 3Z − 2L est respectée', () => {
    assert.ok(Math.abs(mo.upper - (3 * mo.target - 2 * mo.lower)) < 1e-6);
  });

  test('le plancher est respecté et l’ordre des bandes est cohérent', () => {
    const withFloor = millerOrrBands({
      gammaFixed: 25,
      flowSigma: FLOW_SIGMA,
      carryRate: CARRY,
      lower: 500_000,
    });
    assert.equal(withFloor.lower, 500_000);
    assert.ok(withFloor.lower < withFloor.target && withFloor.target < withFloor.upper);
  });

  /**
   * LA propriété du projet (SPEC §1.2).
   *
   * La largeur de bande croît en γ^(1/3). Passer d'un rail de correspondant bancaire à
   * un règlement stablecoin divise le coût fixe par 10⁴, donc la bande par 10⁴^(1/3) ≈ 21,5.
   * C'est l'effondrement du buffer que le backtest doit chiffrer.
   */
  test('la largeur de bande suit exactement la loi en γ^(1/3)', () => {
    const slow = millerOrrBands({ gammaFixed: 25, flowSigma: FLOW_SIGMA, carryRate: CARRY, lower: 0 });
    const fast = millerOrrBands({ gammaFixed: 0.0025, flowSigma: FLOW_SIGMA, carryRate: CARRY, lower: 0 });
    const ratio = (slow.upper - slow.lower) / (fast.upper - fast.lower);
    assert.ok(Math.abs(ratio - Math.cbrt(10_000)) < 0.01, `facteur ${ratio.toFixed(3)} ≠ 21,544`);
  });

  test('les entrées dégénérées sont rejetées', () => {
    assert.throws(() => millerOrrBands({ gammaFixed: 1, flowSigma: 0, carryRate: CARRY, lower: 0 }), RangeError);
    assert.throws(() => millerOrrBands({ gammaFixed: 1, flowSigma: 1, carryRate: 0, lower: 0 }), RangeError);
  });
});

describe('solveur numérique — validation contre la solution analytique (D3)', () => {
  /**
   * Le solveur ne doit pas *égaler* Miller-Orr : il résout un problème strictement plus
   * riche (temps discret, coût de rupture, dérive éventuelle). On vérifie qu'il en
   * reproduit la **structure** là où les hypothèses analytiques sont approximativement
   * valides, c'est-à-dire quand la bande est large devant le choc de flux d'une période.
   */
  test('la largeur numérique suit l’analytique dans le régime de validité', () => {
    for (const gammaFixed of [2, 25, 250]) {
      const { analytic, result } = solve({ gammaFixed });
      const wA = analytic.upper - analytic.lower;
      const wN = result.bands.upper - result.bands.lower;
      assert.ok(
        wN / wA > 0.7 && wN / wA < 1.5,
        `γ=${gammaFixed} : largeur numérique/analytique = ${(wN / wA).toFixed(2)}`,
      );
    }
  });

  test('l’exposant d’échelle numérique reste proche de la racine cubique', () => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const gammaFixed of [0.2, 2, 25, 250]) {
      const { result } = solve({ gammaFixed });
      xs.push(Math.log(gammaFixed));
      ys.push(Math.log(result.bands.upper - result.bands.lower));
    }
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      den += (xs[i]! - mx) ** 2;
    }
    const slope = num / den;
    assert.ok(slope > 0.25 && slope < 0.6, `exposant ${slope.toFixed(3)} hors de [0,25 ; 0,60]`);
  });

  /**
   * Condition de validité du modèle de bandes, découverte en calibrant le solveur.
   *
   * Miller-Orr est un résultat de temps continu : il suppose que le solde dérive
   * lentement jusqu'à toucher une borne. Si le choc de flux d'une période dépasse la
   * largeur de bande, le solde saute par-dessus les bornes à chaque pas et la politique
   * dégénère en « rééquilibrer à chaque période ».
   *
   * C'est ce qui arrive à granularité journalière : un jour de flux déplace le solde EUR
   * de ±1,5 M$ alors que la bande optimale sur rail rapide fait 100 k$. À 15 minutes le
   * choc tombe à ~70 k$ et le modèle redevient applicable — ce qui **justifie
   * quantitativement** le choix d'epoch de la spec, au lieu de le poser par convention.
   */
  test('hors du régime de validité, la politique dégénère en rééquilibrage permanent', () => {
    const { result } = solve({ gammaFixed: 0.02 });
    const pathLength = PATHS[0]!.length;
    const rate = result.outcome.rebalances / pathLength;
    assert.ok(rate > 0.5, `taux de rééquilibrage ${rate.toFixed(2)} : la dégénérescence attendue n'apparaît pas`);
    assert.ok(
      result.bands.upper - result.bands.lower < FLOW_SIGMA,
      'la bande devrait être plus étroite que le choc de flux dans ce régime',
    );
  });
});

describe('propriétés du solveur', () => {
  test('le résultat n’est jamais pire que l’amorçage', () => {
    const { result } = solve({});
    assert.ok(result.outcome.cost <= result.warmStartOutcome.cost);
  });

  test('déterminisme : mêmes trajectoires et mêmes coûts ⇒ mêmes bandes', () => {
    const a = solve({}).result.bands;
    const b = solve({}).result.bands;
    assert.deepEqual(a, b);
  });

  test('les nombres aléatoires communs rendent l’évaluation reproductible', () => {
    const bands = { lower: 100_000, target: 400_000, upper: 900_000 };
    const one = evaluatePolicy(bands, PATHS, baseCosts, TAIL);
    const two = evaluatePolicy(bands, PATHS, baseCosts, TAIL);
    assert.deepEqual(one, two);
  });

  test('le plancher opérationnel est respecté', () => {
    const mo = millerOrrBands({ gammaFixed: 2, flowSigma: FLOW_SIGMA, carryRate: CARRY, lower: 250_000 });
    const r = solveBands({
      paths: PATHS,
      costs: baseCosts,
      tail: TAIL,
      warmStart: mo,
      floor: 250_000,
      initialStep: 100_000,
      tolerance: 1_000,
      maxEvaluations: 4000,
    });
    assert.ok(r.bands.lower >= 250_000);
    assert.ok(r.bands.lower <= r.bands.target && r.bands.target <= r.bands.upper);
  });
});

describe('statique comparative — l’économie du modèle', () => {
  const targetOf = (c: Partial<CostParams>, paths = PATHS) => solve(c, paths).result.bands.target;

  test('un coût de rupture plus élevé fait monter le buffer', () => {
    assert.ok(targetOf({ breachCost: 500_000 }) > targetOf({ breachCost: 20_000 }));
  });

  /**
   * Validation de l'optimiseur par la condition du premier ordre.
   *
   * À l'optimum, le coût marginal de portage d'un dollar supplémentaire de buffer égale
   * la réduction marginale du coût de rupture espéré. Comme le portage ne dépend pas du
   * coût de rupture, la probabilité de rupture optimale doit varier en **1/c_b** : la
   * multiplier par dix doit la diviser par dix.
   *
   * C'est le test le plus exigeant du solveur — il ne vérifie pas une valeur mais une
   * *relation* que seule une optimisation correcte peut produire.
   */
  test('la probabilité de rupture optimale varie en 1/coût de rupture', () => {
    const products: number[] = [];
    for (const breachCost of [5_000, 50_000, 500_000, 5_000_000]) {
      const { result } = solve({ breachCost });
      products.push(breachCost * result.outcome.breachProbability);
    }
    const lo = Math.min(...products);
    const hi = Math.max(...products);
    assert.ok(
      hi / lo < 3,
      `c_b × P* devrait rester quasi constant ; observé ${products.map((x) => x.toFixed(3)).join(', ')}`,
    );
  });

  test('la probabilité de rupture tarifée reste strictement positive', () => {
    const { result } = solve({});
    assert.ok(result.outcome.breachProbability > 0, 'le terme de rupture doit rester actif');
    assert.ok(result.outcome.breachProbability < 1e-3, 'probabilité implausible à l’optimum');
  });

  test('un coût de portage plus élevé fait baisser le buffer', () => {
    assert.ok(targetOf({ carryRate: CARRY * 8 }) < targetOf({ carryRate: CARRY }));
  });

  test('une aversion au risque plus forte fait baisser le buffer', () => {
    const neutral = targetOf({ kappa: 0, esPerUnit: 0.001 });
    const averse = targetOf({ kappa: 2, esPerUnit: 0.001 });
    assert.ok(averse < neutral, `averse ${averse.toFixed(0)} devrait être sous neutre ${neutral.toFixed(0)}`);
  });

  test('une dérive positive de flux réduit le buffer nécessaire', () => {
    assert.ok(targetOf({}, DRIFTED_PATHS) < targetOf({}, PATHS));
  });
});

describe('coût d’exécution', () => {
  test('nul pour un ordre nul, symétrique en signe', () => {
    assert.equal(executionCost(0, baseCosts), 0);
    const p = { ...baseCosts, spreadBps: 5, etaImpact: 0.1 };
    assert.equal(executionCost(1_000, p), executionCost(-1_000, p));
  });

  test('l’impact est convexe : doubler la taille plus que double le coût d’impact', () => {
    const p = { ...baseCosts, spreadBps: 0, etaImpact: 0.1 };
    assert.ok(executionCost(2_000, p) > 2 * executionCost(1_000, p));
  });
});
