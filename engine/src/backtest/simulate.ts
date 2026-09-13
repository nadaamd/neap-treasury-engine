/**
 * Running a policy over an evaluation window.
 *
 * One engine for all four policies: they differ only in their bands and in how often
 * they decide. Any other difference would bias the comparison.
 */

import type { Currency } from '../../../data/src/types.ts';
import { executionCost } from '../bands/simulate.ts';
import { filteredHistoricalES } from '../risk/measures.ts';
import { CURRENCIES, CURRENCY_COSTS, EPOCHS_PER_DAY } from './config.ts';
import type { PolicyBands, WindowMetrics } from './types.ts';

export interface SimulationInput {
  readonly policy: PolicyBands;
  /** Net flows per currency, one element per epoch. */
  readonly flows: Record<Currency, readonly number[]>;
  /** Standardised residuals available at the start date — never beyond it (D10). */
  readonly residuals: readonly (readonly number[])[];
  /** Current conditional volatility per currency, in CURRENCIES order. */
  readonly currentVol: readonly number[];
}

export function runPolicy(input: SimulationInput): WindowMetrics {
  const { policy, flows } = input;
  const epochs = flows[CURRENCIES[0]!]!.length;

  const balance: Record<string, number> = {};
  for (const c of CURRENCIES) balance[c] = policy.bands[c].target;

  let carryCost = 0;
  let execCost = 0;
  let breaches = 0;
  let rebalances = 0;
  let capitalAcc = 0;
  let esAcc = 0;
  let esSamples = 0;

  for (let t = 0; t < epochs; t++) {
    const endOfDay = t % EPOCHS_PER_DAY === EPOCHS_PER_DAY - 1;

    for (const c of CURRENCIES) {
      const cfg = CURRENCY_COSTS[c]!;
      const bands = policy.bands[c];

      balance[c] = balance[c]! + flows[c]![t]!;
      if (balance[c]! < 0) breaches++;
      carryCost += cfg.costs.carryRate * Math.max(balance[c]!, 0);
      capitalAcc += Math.max(balance[c]!, 0);

      // A calendar policy only inspects state at a fixed time; the others do so every
      // epoch. That is the only other difference between the compared policies.
      const shouldLook = policy.calendarOnly ? endOfDay : true;
      if (!shouldLook) continue;

      const outside = balance[c]! < bands.lower || balance[c]! > bands.upper;
      const trigger = policy.calendarOnly ? balance[c]! !== bands.target : outside;
      if (!trigger) continue;

      const q = bands.target - balance[c]!;
      if (Math.abs(q) < 1) continue;
      execCost += cfg.costs.gammaFixed + executionCost(q, cfg.costs);
      rebalances++;
      balance[c] = bands.target;
    }

    if (endOfDay) {
      const weights = CURRENCIES.map((c) => balance[c]!);
      esAcc += filteredHistoricalES({
        residuals: input.residuals,
        currentVol: input.currentVol,
        weights,
        horizonDays: 1,
        alpha: 0.975,
      }).es;
      esSamples++;
    }
  }

  const steps = epochs * CURRENCIES.length;
  return {
    capital: capitalAcc / steps,
    es: esSamples > 0 ? esAcc / esSamples : 0,
    executionCost: execCost,
    carryCost,
    breaches,
    rebalances,
    totalCost: carryCost + execCost,
  };
}
