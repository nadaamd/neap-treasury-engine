/**
 * Points d'entrée servis à l'enclave pendant la simulation.
 *
 * Ils matérialisent la frontière de confidentialité : `/treasury` exige un jeton porteur
 * et renvoie ce qui ne doit jamais sortir de l'enclave ; `/market` est ouvert et ne
 * renvoie que du public. Si les deux étaient sur le même point d'entrée, la distinction
 * ne serait qu'un commentaire.
 */

import { CORRIDORS } from '../../data/calibration/corridors.ts';
import { generateFlows } from '../../data/src/generator.ts';
import { bucketize } from '../../data/src/aggregate.ts';
import { simulateMarket, RISK_CURRENCIES } from '../../data/src/market.ts';
import { standardizedResiduals } from '../../engine/src/risk/residuals.ts';
import { buildPolicy } from '../../engine/src/backtest/policies.ts';
import { CURRENCIES, CURRENCY_COSTS, EPOCHS_PER_DAY, EPOCH_MS, FAST_CONFIG } from '../../engine/src/backtest/config.ts';
import type { Currency } from '../../data/src/types.ts';
import type { MarketSnapshot, TreasurySnapshot } from '../../cre/handler/types.ts';

const SEED = 1000;
const DAYS = 40;
const START_TS = Date.UTC(2026, 8, 1);

let cached: { treasury: TreasurySnapshot; market: MarketSnapshot } | null = null;

function build(): { treasury: TreasurySnapshot; market: MarketSnapshot } {
  const events = generateFlows({ seed: SEED, startTs: START_TS, days: DAYS, corridors: CORRIDORS });
  const buckets = bucketize(events, START_TS, EPOCH_MS, DAYS * EPOCHS_PER_DAY);
  const flows = {} as Record<Currency, number[]>;
  for (const c of CURRENCIES) flows[c] = buckets.map((b) => b.net[c]);

  const market = simulateMarket(SEED + 500_000, DAYS);
  const { residuals, currentVol } = standardizedResiduals(market.returns, RISK_CURRENCIES);

  const dailyVol = {} as Record<Currency, number>;
  CURRENCIES.forEach((c, i) => {
    dailyVol[c] = currentVol[i]!;
  });

  const { bands } = buildPolicy('NEAP', {
    calibration: flows,
    evaluation: flows,
    dailyVol,
    cfg: { ...FAST_CONFIG, solverPaths: 100, solverPathLength: 160 },
    seed: SEED,
  });

  // Un solde volontairement sous le seuil bas : la simulation doit produire un plan,
  // pas un NOOP. Un exemple qui ne fait rien ne démontre rien.
  const balances: Record<string, number> = { USD: 20_000_000 };
  for (const c of CURRENCIES) balances[c] = bands[c].target;
  balances.EUR = bands.EUR.lower * 0.4;

  const limits: Record<string, TreasurySnapshot['limits'][string]> = {};
  for (const c of CURRENCIES) {
    limits[c] = {
      costs: CURRENCY_COSTS[c]!.costs,
      maxSingleOrder: 5_000_000,
      settlementDays: CURRENCY_COSTS[c]!.settlementDays,
    };
  }

  return {
    treasury: {
      epoch: 100,
      nonce: 1,
      balances,
      commitments: [],
      policyVersion: 3,
      bandParamsHash: `0x${'11'.repeat(32)}`,
      bands,
      limits,
      risk: {
        horizonDays: 1 / EPOCHS_PER_DAY,
        alpha: 0.975,
        basisHaircutBps: 50,
        lotSize: 10_000,
        minOrder: 20_000,
        autoApproveThreshold: 1_000_000,
        maxPerEpoch: 10_000_000,
        fundingFloor: 1_000_000,
        maxStalenessSec: 86_400,
      },
    },
    market: {
      timestamp: Date.now(),
      currentVol,
      residuals: residuals.slice(-250),
      rates: { EUR: 0.92, GBP: 0.79, BRL: 5.4 },
      gasUsdc: 0.02,
    },
  };
}

function snapshots() {
  if (cached === null) cached = build();
  return cached;
}

/** L'état confidentiel — protégé par le jeton que l'enclave présente. */
export function treasuryPayload(authorization: string | undefined, expected: string): string | null {
  if (authorization !== `Bearer ${expected}`) return null;
  return JSON.stringify(snapshots().treasury);
}

/** Le marché — public, et le rester est un choix documenté. */
export function marketPayload(): string {
  return JSON.stringify({ ...snapshots().market, timestamp: Date.now() });
}
