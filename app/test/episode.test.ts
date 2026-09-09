/**
 * Tests de l'épisode servi au tableau de bord.
 *
 * Ils existent parce que deux défauts ont échappé à la relecture et n'auraient pas été
 * visibles sur une capture d'écran. Le premier rendait les curseurs purement décoratifs ;
 * le second rendait invisible le moment le plus démonstratif de la démonstration.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildEpisode, DEFAULT_PARAMS } from '../src/episode.ts';
import { CURRENCIES } from '../../engine/src/backtest/config.ts';

const base = { ...DEFAULT_PARAMS, days: 1 };
const totalTarget = (e: ReturnType<typeof buildEpisode>) =>
  CURRENCIES.reduce((a, c) => a + e.bands[c]!.target, 0);

describe('épisode', () => {
  test('déterministe à paramètres identiques', () => {
    assert.deepEqual(buildEpisode(base), buildEpisode(base));
  });

  test('les bandes sont ordonnées et positives', () => {
    const e = buildEpisode(base);
    for (const c of CURRENCIES) {
      const b = e.bands[c]!;
      assert.ok(b.lower >= 0 && b.lower <= b.target && b.target <= b.upper, `bandes ${c}`);
    }
  });

  test('chaque pas expose le solde constaté et le solde après décision', () => {
    const e = buildEpisode(base);
    for (const s of e.steps) {
      for (const c of CURRENCIES) {
        assert.equal(typeof s.observed[c], 'number');
        assert.equal(typeof s.balances[c], 'number');
      }
    }
  });

  /**
   * Régression. Le tableau de bord n'exposait que le solde postérieur à la décision ;
   * un choc de liquidité était corrigé dans le même epoch et l'écran n'en gardait
   * aucune trace. Le solde constaté avant décision doit rester lisible.
   */
  test('un choc de liquidité est visible dans le solde constaté', () => {
    const calm = buildEpisode({ ...base, days: 2 });
    const shocked = buildEpisode({
      ...base,
      days: 2,
      shockAt: 40,
      shockCurrency: 'BRL',
      shockAmount: 2_500_000,
    });
    assert.notEqual(shocked.steps[40]!.observed.BRL, calm.steps[40]!.observed.BRL);
    assert.ok(shocked.steps[40]!.observed.BRL! < 0, 'le choc devrait creuser le solde sous zéro');
    assert.ok(shocked.steps[40]!.actions.length > 0, 'aucune réaction au choc');
  });

  test('le solde est ramené à la cible lorsqu’une action est émise', () => {
    const e = buildEpisode({ ...base, days: 2 });
    for (const s of e.steps) {
      for (const a of s.actions) {
        assert.ok(
          Math.abs(s.balances[a.currency]! - e.bands[a.currency]!.target) < 1e-6,
          `${a.currency} non ramené à la cible`,
        );
      }
    }
  });
});

/**
 * Régression. Les coûts modulés par les curseurs n'étaient utilisés que pour la
 * comptabilité d'exécution : le solveur lisait toujours les constantes du dépôt, et les
 * curseurs ne déplaçaient aucune bande. La page affichait des paramètres qu'elle
 * prétendait faire varier.
 */
describe('les curseurs pilotent réellement la résolution des bandes', () => {
  test('une aversion au risque plus forte réduit le buffer', () => {
    const neutral = buildEpisode({ ...base, kappa: 0 });
    const averse = buildEpisode({ ...base, kappa: 4 });
    assert.ok(
      totalTarget(averse) < totalTarget(neutral),
      `κ sans effet : ${totalTarget(neutral).toFixed(0)} → ${totalTarget(averse).toFixed(0)}`,
    );
  });

  test('un coût de rupture plus élevé épaissit le buffer', () => {
    const cheap = buildEpisode({ ...base, breachCost: 1_000 });
    const dear = buildEpisode({ ...base, breachCost: 25_000_000 });
    assert.ok(
      totalTarget(dear) > totalTarget(cheap),
      `c_b sans effet : ${totalTarget(cheap).toFixed(0)} → ${totalTarget(dear).toFixed(0)}`,
    );
  });

  test('un impact plus élevé renchérit l’exécution', () => {
    const light = buildEpisode({ ...base, etaScale: 0.5 });
    const heavy = buildEpisode({ ...base, etaScale: 4 });
    assert.ok(heavy.summary.totalCost > light.summary.totalCost);
  });
});
