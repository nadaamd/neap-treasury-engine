/**
 * Tests de validité du générateur de flux — SPEC §17.2.
 *
 * Un générateur synthétique n'est défendable que s'il est testé. Ces cinq tests sont
 * la seule chose qui distingue une simulation calibrée d'un tirage arbitraire, et le
 * test de reproductibilité est celui qu'un juge peut vérifier en dix secondes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CORRIDORS, GAMMA_RATIO } from '../calibration/corridors.ts';
import { generateFlows } from '../src/generator.ts';
import { bucketize, grossVolumeSeries } from '../src/aggregate.ts';
import { DOM_PROFILE, DOW_PROFILE, HOUR_PROFILE, seasonalFactor } from '../src/seasonality.ts';
import { autocorrelation, fingerprint, kurtosis, mean } from '../src/stats.ts';

const START = Date.UTC(2025, 0, 1, 0, 0, 0);
const DAY_MS = 86_400_000;
const DAYS = 180;
const SEED = 20260909;

const events = generateFlows({ seed: SEED, startTs: START, days: DAYS, corridors: CORRIDORS });

describe('1 — volume quotidien conforme à la calibration (±10 %)', () => {
  for (const c of CORRIDORS) {
    test(c.id, () => {
      const own = events.filter((e) => e.corridorId === c.id);
      const observed = own.reduce((a, e) => a + e.notionalUsd, 0) / DAYS;
      const ratio = observed / c.dailyVolumeUsd;
      assert.ok(
        ratio > 0.9 && ratio < 1.1,
        `${c.id} : volume quotidien observé ${(observed / 1e6).toFixed(2)} M$ ` +
          `vs cible ${(c.dailyVolumeUsd / 1e6).toFixed(2)} M$ (ratio ${ratio.toFixed(3)})`,
      );
    });
  }

  test('la taille moyenne de paiement est respectée', () => {
    for (const c of CORRIDORS) {
      const own = events.filter((e) => e.corridorId === c.id);
      const avg = mean(own.map((e) => e.notionalUsd));
      const ratio = avg / c.avgTicketUsd;
      assert.ok(ratio > 0.9 && ratio < 1.1, `${c.id} : ticket moyen ratio ${ratio.toFixed(3)}`);
    }
  });

  test('le déséquilibre directionnel est respecté', () => {
    for (const c of CORRIDORS) {
      const own = events.filter((e) => e.corridorId === c.id);
      const baseToQuote = own.filter((e) => e.receive === c.base).length / own.length;
      const expected = (1 + c.imbalance) / 2;
      assert.ok(
        Math.abs(baseToQuote - expected) < 0.02,
        `${c.id} : part base→quote ${baseToQuote.toFixed(3)} vs attendu ${expected.toFixed(3)}`,
      );
    }
  });
});

describe('2 — profils de saisonnalité', () => {
  test('chaque profil a une moyenne de 1 sur son cycle', () => {
    for (const [name, p] of [
      ['horaire', HOUR_PROFILE],
      ['hebdomadaire', DOW_PROFILE],
      ['mensuel', DOM_PROFILE],
    ] as const) {
      assert.ok(
        Math.abs(mean(p as readonly number[]) - 1) < 1e-12,
        `profil ${name} : moyenne ${mean(p as readonly number[])}`,
      );
    }
  });

  test('le facteur combiné reste sans biais sur deux ans (±3 %)', () => {
    const factors: number[] = [];
    for (let h = 0; h < 2 * 365 * 24; h++) factors.push(seasonalFactor(START + h * 3_600_000));
    const m = mean(factors);
    assert.ok(Math.abs(m - 1) < 0.03, `moyenne du facteur combiné : ${m.toFixed(4)}`);
  });

  test('le creux de week-end est de l’ordre de −60 %', () => {
    const weekday = mean([1, 2, 3, 4, 5].map((d) => DOW_PROFILE[d]!));
    const weekend = mean([0, 6].map((d) => DOW_PROFILE[d]!));
    const drop = 1 - weekend / weekday;
    assert.ok(drop > 0.5 && drop < 0.7, `creux de week-end : ${(drop * 100).toFixed(1)} %`);
  });
});

describe('3 — structure d’autocorrélation', () => {
  const series = grossVolumeSeries(events, START, DAY_MS, DAYS);
  const acf = Array.from({ length: 16 }, (_, i) => autocorrelation(series, i + 1));
  const at = (lag: number) => acf[lag - 1]!;

  /**
   * On ne teste PAS que le maximum global de l'autocorrélogramme soit au retard 7.
   *
   * Ce serait une mauvaise spécification : le profil hebdomadaire est un bloc de cinq
   * jours hauts suivi de deux jours bas, donc la plupart des paires de jours adjacents
   * sont hautes toutes les deux et acf(1) est mécaniquement élevée. C'est une propriété
   * du signal, pas un défaut.
   *
   * La signature d'une périodicité, c'est un **maximum local aux multiples de la période**.
   * C'est ce qu'on vérifie, aux retards 7 et 14.
   */
  test('maximum local marqué au retard 7', () => {
    assert.ok(at(7) > 0.3, `acf(7) = ${at(7).toFixed(3)}`);
    assert.ok(at(7) > at(6) + 0.15, `acf(7)=${at(7).toFixed(3)} vs acf(6)=${at(6).toFixed(3)}`);
    assert.ok(at(7) > at(8) + 0.15, `acf(7)=${at(7).toFixed(3)} vs acf(8)=${at(8).toFixed(3)}`);
  });

  test('l’harmonique au retard 14 confirme la période', () => {
    assert.ok(at(14) > 0.3, `acf(14) = ${at(14).toFixed(3)}`);
    assert.ok(at(14) > at(13) + 0.15, `acf(14)=${at(14).toFixed(3)} vs acf(13)=${at(13).toFixed(3)}`);
    assert.ok(at(14) > at(15) + 0.15, `acf(14)=${at(14).toFixed(3)} vs acf(15)=${at(15).toFixed(3)}`);
  });

  test('les retards non multiples de 7 sont nettement plus faibles', () => {
    for (const lag of [3, 4, 5, 10, 11, 12]) {
      assert.ok(at(lag) < 0.2, `acf(${lag}) = ${at(lag).toFixed(3)} devrait être faible`);
    }
  });
});

describe('4 — queue épaisse des montants', () => {
  test('la kurtosis dépasse largement celle d’une gaussienne', () => {
    for (const c of CORRIDORS) {
      const amounts = events.filter((e) => e.corridorId === c.id).map((e) => e.notionalUsd);
      const k = kurtosis(amounts);
      assert.ok(k > 3, `${c.id} : kurtosis ${k.toFixed(1)} (gaussienne = 3)`);
    }
  });

  test('une minorité de paiements porte la majorité du volume', () => {
    const amounts = events.map((e) => e.notionalUsd).sort((a, b) => b - a);
    const total = amounts.reduce((a, b) => a + b, 0);
    const topDecile = amounts.slice(0, Math.floor(amounts.length * 0.1));
    const share = topDecile.reduce((a, b) => a + b, 0) / total;
    assert.ok(share > 0.4, `part du décile supérieur : ${(share * 100).toFixed(1)} %`);
  });
});

describe('5 — reproductibilité', () => {
  test('même seed ⇒ sortie identique', () => {
    const a = generateFlows({ seed: SEED, startTs: START, days: 30, corridors: CORRIDORS });
    const b = generateFlows({ seed: SEED, startTs: START, days: 30, corridors: CORRIDORS });
    assert.equal(a.length, b.length);
    assert.equal(fingerprint(a.map((e) => e.notionalUsd)), fingerprint(b.map((e) => e.notionalUsd)));
    assert.equal(fingerprint(a.map((e) => e.ts)), fingerprint(b.map((e) => e.ts)));
  });

  test('seed différent ⇒ sortie différente', () => {
    const a = generateFlows({ seed: 1, startTs: START, days: 30, corridors: CORRIDORS });
    const b = generateFlows({ seed: 2, startTs: START, days: 30, corridors: CORRIDORS });
    assert.notEqual(
      fingerprint(a.map((e) => e.notionalUsd)),
      fingerprint(b.map((e) => e.notionalUsd)),
    );
  });
});

describe('cohérence de l’agrégation', () => {
  test('les flux nets se compensent : tout paiement crédite une devise et en débite une autre', () => {
    const buckets = bucketize(events, START, DAY_MS, DAYS);
    const totalNet = buckets.reduce(
      (a, b) => a + b.net.USD + b.net.EUR + b.net.GBP + b.net.BRL,
      0,
    );
    const totalGross = events.reduce((a, e) => a + e.notionalUsd, 0);
    assert.ok(
      Math.abs(totalNet) / totalGross < 1e-12,
      `somme des flux nets ${totalNet} non nulle relativement au brut ${totalGross}`,
    );
  });

  test('aucun événement n’est perdu par l’agrégation', () => {
    const buckets = bucketize(events, START, DAY_MS, DAYS);
    assert.equal(buckets.reduce((a, b) => a + b.count, 0), events.length);
  });
});

describe('posture hybride (D2)', () => {
  test('le ratio des coûts fixes entre rails est d’au moins trois ordres de grandeur', () => {
    assert.ok(GAMMA_RATIO >= 1000, `ratio gamma = ${GAMMA_RATIO}`);
  });
});
