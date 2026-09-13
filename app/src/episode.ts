/**
 * Building a replayable episode: flows, bands, decisions, risk, costs.
 *
 * The dashboard computes nothing itself. The server produces a complete episode in one
 * call and the client merely animates it — one network round trip per fifteen-minute
 * epoch would make the demo stutter and hide what it is meant to show.
 */

import { CORRIDORS } from '../../data/calibration/corridors.ts';
import { generateFlows } from '../../data/src/generator.ts';
import { bucketize } from '../../data/src/aggregate.ts';
import { simulateMarket, RISK_CURRENCIES } from '../../data/src/market.ts';
import type { Currency } from '../../data/src/types.ts';
import { CURRENCIES, CURRENCY_COSTS, EPOCHS_PER_DAY, EPOCH_MS } from '../../engine/src/backtest/config.ts';
import { FAST_CONFIG } from '../../engine/src/backtest/config.ts';
import { buildPolicy, esPerUnit } from '../../engine/src/backtest/policies.ts';
import { executionCost } from '../../engine/src/bands/simulate.ts';
import type { Bands } from '../../engine/src/bands/millerOrr.ts';
import { standardizedResiduals } from '../../engine/src/risk/residuals.ts';
import { filteredHistoricalES } from '../../engine/src/risk/measures.ts';

export interface EpisodeAction {
  readonly currency: Currency;
  /** Positive: buy the currency. Negative: sweep the excess. */
  readonly amount: number;
  readonly cost: number;
}

export interface EpisodeStep {
  readonly t: number;
  /**
   * Balance observed after the flows but **before** the decision.
   *
   * This is the information the engine decides on, so this is what has to be shown. The
   * first version exposed only the final balance: a liquidity shock was immediately
   * corrected by a rebalance and the screen kept no trace of it — the most telling moment
   * of the demo was invisible.
   */
  readonly observed: Record<string, number>;
  /** Balance after the decision. */
  readonly balances: Record<string, number>;
  readonly flows: Record<string, number>;
  readonly actions: readonly EpisodeAction[];
  /** Portfolio ES 97.5% after the decision. */
  readonly es: number;
  readonly breach: boolean;
  readonly cumulativeCost: number;
}

export interface EpisodeParams {
  readonly seed: number;
  readonly days: number;
  readonly kappa: number;
  readonly etaScale: number;
  readonly breachCost: number;
  /** Epoch at which to inject a shock, or null. */
  readonly shockAt: number | null;
  readonly shockCurrency: Currency;
  readonly shockAmount: number;
}

export interface Episode {
  readonly params: EpisodeParams;
  readonly bands: Record<string, Bands>;
  readonly steps: readonly EpisodeStep[];
  readonly summary: {
    readonly capital: number;
    readonly totalCost: number;
    readonly rebalances: number;
    readonly breaches: number;
    readonly maxEs: number;
  };
}

export const DEFAULT_PARAMS: EpisodeParams = {
  seed: 1000,
  days: 5,
  kappa: 0.1,
  etaScale: 1,
  breachCost: 50_000,
  shockAt: null,
  shockCurrency: 'BRL',
  shockAmount: 2_500_000,
};

const CALIBRATION_DAYS = 60;
const START_TS = Date.UTC(2026, 8, 1);

function flowSeries(seed: number, days: number): Record<Currency, number[]> {
  const events = generateFlows({ seed, startTs: START_TS, days, corridors: CORRIDORS });
  const buckets = bucketize(events, START_TS, EPOCH_MS, days * EPOCHS_PER_DAY);
  const out = {} as Record<Currency, number[]>;
  for (const c of CURRENCIES) out[c] = buckets.map((b) => b.net[c]);
  return out;
}

export function buildEpisode(params: EpisodeParams): Episode {
  const totalDays = CALIBRATION_DAYS + params.days;
  const flows = flowSeries(params.seed, totalDays);
  const calibEpochs = CALIBRATION_DAYS * EPOCHS_PER_DAY;

  const market = simulateMarket(params.seed + 500_000, totalDays);
  const { residuals, currentVol } = standardizedResiduals(
    Object.fromEntries(
      RISK_CURRENCIES.map((c) => [c, market.returns[c]!.slice(0, CALIBRATION_DAYS)]),
    ),
    CURRENCIES,
  );

  // Costs are copied then modulated by the dashboard sliders: the repository constants
  // must never be mutated by an HTTP request.
  const costs = {} as Record<Currency, ReturnType<typeof scaleCosts>>;
  const dailyVol = {} as Record<Currency, number>;
  CURRENCIES.forEach((c, i) => {
    costs[c] = scaleCosts(c, params);
    dailyVol[c] = currentVol[i]!;
  });

  const calibration = {} as Record<Currency, number[]>;
  const evaluation = {} as Record<Currency, number[]>;
  for (const c of CURRENCIES) {
    calibration[c] = flows[c]!.slice(0, calibEpochs);
    evaluation[c] = flows[c]!.slice(calibEpochs);
  }

  const { bands } = buildPolicy('NEAP', {
    calibration,
    evaluation,
    dailyVol,
    cfg: { ...FAST_CONFIG, solverPaths: 120, solverPathLength: 200 },
    seed: params.seed,
    costs,
  });

  const balances: Record<string, number> = {};
  for (const c of CURRENCIES) balances[c] = bands[c].target;

  const steps: EpisodeStep[] = [];
  let cumulativeCost = 0;
  let capitalAcc = 0;
  let rebalances = 0;
  let breaches = 0;
  let maxEs = 0;

  const epochs = evaluation[CURRENCIES[0]!]!.length;
  for (let t = 0; t < epochs; t++) {
    const stepFlows: Record<string, number> = {};
    const observed: Record<string, number> = {};
    const actions: EpisodeAction[] = [];
    let breach = false;

    for (const c of CURRENCIES) {
      let flow = evaluation[c]![t]!;
      if (params.shockAt === t && c === params.shockCurrency) flow -= params.shockAmount;
      stepFlows[c] = flow;

      balances[c] = balances[c]! + flow;
      if (balances[c]! < 0) {
        breach = true;
        breaches++;
      }
      capitalAcc += Math.max(balances[c]!, 0);
      observed[c] = balances[c]!;

      const b = bands[c];
      if (balances[c]! < b.lower || balances[c]! > b.upper) {
        const q = b.target - balances[c]!;
        const cost = costs[c].gammaFixed + executionCost(q, costs[c]);
        cumulativeCost += cost;
        rebalances++;
        balances[c] = b.target;
        actions.push({ currency: c, amount: q, cost });
      }
    }

    const es = filteredHistoricalES({
      residuals,
      currentVol,
      weights: CURRENCIES.map((c) => balances[c]!),
      horizonDays: 1 / EPOCHS_PER_DAY,
      alpha: 0.975,
    }).es;
    if (es > maxEs) maxEs = es;

    steps.push({
      t,
      observed,
      balances: { ...balances },
      flows: stepFlows,
      actions,
      es,
      breach,
      cumulativeCost,
    });
  }

  return {
    params,
    bands,
    steps,
    summary: {
      capital: capitalAcc / (epochs * CURRENCIES.length),
      totalCost: cumulativeCost,
      rebalances,
      breaches,
      maxEs,
    },
  };
}

function scaleCosts(c: Currency, params: EpisodeParams) {
  const base = CURRENCY_COSTS[c]!.costs;
  return {
    ...base,
    etaImpact: base.etaImpact * params.etaScale,
    kappa: params.kappa,
    breachCost: params.breachCost,
    esPerUnit: esPerUnit(0.005),
  };
}
