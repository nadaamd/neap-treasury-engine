/**
 * Walk-forward protocol — decision D10, SPEC §18.1.
 *
 *   for each window w:
 *       calibration  over [t0, t_w)          ← strict past
 *       evaluation   over [t_w, t_{w+1})     ← future never seen
 *
 * No parameter used at time t may have been estimated with data later than t. The
 * constraint is simple to state and easy to violate by accident — hence the canary in
 * the test suite, which injects an extreme value into the future and checks that no
 * earlier decision is affected by it.
 *
 * The single exception is deliberate and has a name: CLAIRVOYANT calibrates on the
 * evaluation window. It is not a policy, it is a reference bound.
 */

import { CORRIDORS } from '../../../data/calibration/corridors.ts';
import { generateFlows } from '../../../data/src/generator.ts';
import { bucketize } from '../../../data/src/aggregate.ts';
import { simulateMarket, RISK_CURRENCIES } from '../../../data/src/market.ts';
import { ewmaVolSeries, ewmaVolNext } from '../risk/ewma.ts';
import type { Currency } from '../../../data/src/types.ts';
import { CURRENCIES, EPOCHS_PER_DAY, EPOCH_MS } from './config.ts';
import type { BacktestConfig } from './config.ts';
import { buildPolicy } from './policies.ts';
import { runPolicy } from './simulate.ts';
import type { BacktestSummary, Interval, PolicyKind, SeedResult, WindowMetrics } from './types.ts';

const POLICIES: readonly PolicyKind[] = ['STATIC', 'CALENDAR', 'NEAP', 'CLAIRVOYANT'];

const EMPTY: WindowMetrics = {
  capital: 0,
  es: 0,
  executionCost: 0,
  carryCost: 0,
  breaches: 0,
  rebalances: 0,
  totalCost: 0,
};

function add(a: WindowMetrics, b: WindowMetrics): WindowMetrics {
  return {
    capital: a.capital + b.capital,
    es: a.es + b.es,
    executionCost: a.executionCost + b.executionCost,
    carryCost: a.carryCost + b.carryCost,
    breaches: a.breaches + b.breaches,
    rebalances: a.rebalances + b.rebalances,
    totalCost: a.totalCost + b.totalCost,
  };
}

function scale(a: WindowMetrics, k: number): WindowMetrics {
  return {
    capital: a.capital * k,
    es: a.es * k,
    executionCost: a.executionCost * k,
    carryCost: a.carryCost * k,
    breaches: a.breaches * k,
    rebalances: a.rebalances * k,
    totalCost: a.totalCost * k,
  };
}

function slice(
  series: Record<Currency, number[]>,
  from: number,
  to: number,
): Record<Currency, number[]> {
  const out = {} as Record<Currency, number[]>;
  for (const c of CURRENCIES) out[c] = series[c]!.slice(from, to);
  return out;
}

export function runSeed(seed: number, cfg: BacktestConfig): SeedResult {
  const totalDays = cfg.warmupDays + cfg.evalDays * cfg.windows;
  const epochs = totalDays * EPOCHS_PER_DAY;

  const events = generateFlows({
    seed,
    startTs: cfg.startTs,
    days: totalDays,
    corridors: CORRIDORS,
  });
  const buckets = bucketize(events, cfg.startTs, EPOCH_MS, epochs);
  const flows = {} as Record<Currency, number[]>;
  for (const c of CURRENCIES) flows[c] = buckets.map((b) => b.net[c]);

  // The market is drawn from a different seed: nothing ties FX shocks to payment flows,
  // and assuming a dependence we cannot measure would be worse than ignoring it.
  const market = simulateMarket(seed + 500_000, totalDays);

  const totals = {} as Record<PolicyKind, WindowMetrics>;
  for (const k of POLICIES) totals[k] = EMPTY;

  for (let w = 0; w < cfg.windows; w++) {
    const calibEndDay = cfg.warmupDays + w * cfg.evalDays;
    const evalEndDay = calibEndDay + cfg.evalDays;

    const calibration = slice(flows, 0, calibEndDay * EPOCHS_PER_DAY);
    const evaluation = slice(flows, calibEndDay * EPOCHS_PER_DAY, evalEndDay * EPOCHS_PER_DAY);

    // Volatility and residuals stop at the last calibration day — never beyond.
    const dailyVol = {} as Record<Currency, number>;
    const residuals: number[][] = [];
    const currentVol: number[] = [];
    const perCurrency = RISK_CURRENCIES.map((c) => {
      const r = market.returns[c]!.slice(0, calibEndDay);
      const { vol, warmup } = ewmaVolSeries(r);
      return { z: vol.map((s, k) => r[warmup + k]! / s), next: ewmaVolNext(r) };
    });
    RISK_CURRENCIES.forEach((c, i) => {
      dailyVol[c as Currency] = perCurrency[i]!.next;
      currentVol.push(perCurrency[i]!.next);
    });
    const zLen = Math.min(...perCurrency.map((p) => p.z.length));
    for (let t = 0; t < zLen; t++) residuals.push(perCurrency.map((p) => p.z[t]!));

    for (const kind of POLICIES) {
      const policy = buildPolicy(kind, {
        calibration,
        evaluation,
        dailyVol,
        cfg,
        seed: seed * 31 + w,
      });
      const m = runPolicy({ policy, flows: evaluation, residuals, currentVol });
      totals[kind] = add(totals[kind], m);
    }
  }

  const byPolicy = {} as Record<PolicyKind, SeedResult['byPolicy'][PolicyKind]>;
  for (const kind of POLICIES) {
    const averaged = scale(totals[kind], 1 / cfg.windows);
    byPolicy[kind] = { kind, ...averaged };
  }
  return { seed, windows: cfg.windows, byPolicy };
}

function interval(values: readonly number[]): Interval {
  const n = values.length;
  const m = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean: m, halfWidth: 0, n };
  const variance = values.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1);
  return { mean: m, halfWidth: 1.96 * Math.sqrt(variance / n), n };
}

export function runBacktest(cfg: BacktestConfig): BacktestSummary {
  const results = cfg.seeds.map((s) => runSeed(s, cfg));
  const keys: (keyof WindowMetrics)[] = [
    'capital',
    'es',
    'executionCost',
    'carryCost',
    'breaches',
    'rebalances',
    'totalCost',
  ];

  const metrics = {} as BacktestSummary['metrics'];
  for (const kind of POLICIES) {
    const perKey = {} as Record<keyof WindowMetrics, Interval>;
    for (const key of keys) perKey[key] = interval(results.map((r) => r.byPolicy[kind][key]));
    metrics[kind] = perKey;
  }

  // Computed per seed then aggregated: aggregating costs first and dividing afterwards
  // would hide the dispersion, which is precisely what we want to report.
  const estimation = results
    .map((r) => (r.byPolicy.NEAP.totalCost - r.byPolicy.CLAIRVOYANT.totalCost)
      / r.byPolicy.CLAIRVOYANT.totalCost)
    .filter((x) => Number.isFinite(x));

  return {
    seeds: cfg.seeds.length,
    windows: cfg.windows,
    metrics,
    estimationCost: interval(estimation.length > 0 ? estimation : [Number.NaN]),
  };
}
