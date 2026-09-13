/**
 * Tests for the episode served to the dashboard.
 *
 * They exist because two defects slipped past review and would not have been visible on a
 * screenshot. The first made the sliders purely decorative; the second made the most
 * telling moment of the demo invisible.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildEpisode, DEFAULT_PARAMS } from '../src/episode.ts';
import { CURRENCIES } from '../../engine/src/backtest/config.ts';

const base = { ...DEFAULT_PARAMS, days: 1 };
const totalTarget = (e: ReturnType<typeof buildEpisode>) =>
  CURRENCIES.reduce((a, c) => a + e.bands[c]!.target, 0);

describe('episode', () => {
  test('deterministic for identical parameters', () => {
    assert.deepEqual(buildEpisode(base), buildEpisode(base));
  });

  test('the bands are ordered and positive', () => {
    const e = buildEpisode(base);
    for (const c of CURRENCIES) {
      const b = e.bands[c]!;
      assert.ok(b.lower >= 0 && b.lower <= b.target && b.target <= b.upper, `bands ${c}`);
    }
  });

  test('every step exposes the observed balance and the post-decision balance', () => {
    const e = buildEpisode(base);
    for (const s of e.steps) {
      for (const c of CURRENCIES) {
        assert.equal(typeof s.observed[c], 'number');
        assert.equal(typeof s.balances[c], 'number');
      }
    }
  });

  /**
   * Regression. The dashboard exposed only the post-decision balance; a liquidity shock
   * was corrected within the same epoch and the screen kept no trace of it. The balance
   * observed before the decision must stay legible.
   */
  test('a liquidity shock is visible in the observed balance', () => {
    const calm = buildEpisode({ ...base, days: 2 });
    const shocked = buildEpisode({
      ...base,
      days: 2,
      shockAt: 40,
      shockCurrency: 'BRL',
      shockAmount: 2_500_000,
    });
    assert.notEqual(shocked.steps[40]!.observed.BRL, calm.steps[40]!.observed.BRL);
    assert.ok(shocked.steps[40]!.observed.BRL! < 0, 'the shock should push the balance below zero');
    assert.ok(shocked.steps[40]!.actions.length > 0, 'no reaction to the shock');
  });

  test('the balance returns to target whenever an action is emitted', () => {
    const e = buildEpisode({ ...base, days: 2 });
    for (const s of e.steps) {
      for (const a of s.actions) {
        assert.ok(
          Math.abs(s.balances[a.currency]! - e.bands[a.currency]!.target) < 1e-6,
          `${a.currency} not returned to target`,
        );
      }
    }
  });
});

/**
 * Regression. Costs modulated by the sliders were used only for execution accounting: the
 * solver always read the repository constants, and the sliders moved no band. The page
 * displayed parameters it claimed to be varying.
 */
describe('the sliders genuinely drive the band solving', () => {
  test('stronger risk aversion reduces the buffer', () => {
    const neutral = buildEpisode({ ...base, kappa: 0 });
    const averse = buildEpisode({ ...base, kappa: 4 });
    assert.ok(
      totalTarget(averse) < totalTarget(neutral),
      `κ has no effect: ${totalTarget(neutral).toFixed(0)} → ${totalTarget(averse).toFixed(0)}`,
    );
  });

  test('a higher breach cost thickens the buffer', () => {
    const cheap = buildEpisode({ ...base, breachCost: 1_000 });
    const dear = buildEpisode({ ...base, breachCost: 25_000_000 });
    assert.ok(
      totalTarget(dear) > totalTarget(cheap),
      `c_b has no effect: ${totalTarget(cheap).toFixed(0)} → ${totalTarget(dear).toFixed(0)}`,
    );
  });

  test('a higher impact makes execution more expensive', () => {
    const light = buildEpisode({ ...base, etaScale: 0.5 });
    const heavy = buildEpisode({ ...base, etaScale: 4 });
    assert.ok(heavy.summary.totalCost > light.summary.totalCost);
  });
});
