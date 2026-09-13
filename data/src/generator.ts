/**
 * Payment flow generator — SPEC §17.
 *
 * Compound Poisson process with seasonal intensity:
 *   arrivals  N_h ~ Poisson( lambda_daily / 24 · s_hour · s_dow · s_dom )
 *   amounts   X_i ~ LogNormal with mean `avgTicketUsd` and shape `tailSigma`
 *   direction Bernoulli driven by the corridor imbalance
 *
 * Determinism: a single Rng, consumed in a fixed order (increasing hour, then corridors
 * in array order). Same seed ⇒ same output, byte for byte.
 */

import { Rng } from './random.ts';
import { seasonalFactor } from './seasonality.ts';
import type { CorridorSpec, FlowEvent } from './types.ts';

const HOUR_MS = 3_600_000;

export interface GenerateOptions {
  readonly seed: number;
  /** Start of the simulation, aligned on a UTC hour. */
  readonly startTs: number;
  readonly days: number;
  readonly corridors: readonly CorridorSpec[];
}

export function generateFlows(opts: GenerateOptions): FlowEvent[] {
  const { seed, startTs, days, corridors } = opts;
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`days must be a positive integer, received ${days}`);
  }
  if (startTs % HOUR_MS !== 0) {
    throw new RangeError('startTs must be aligned on a UTC hour');
  }

  const rng = new Rng(seed);
  const events: FlowEvent[] = [];
  const totalHours = days * 24;

  for (let h = 0; h < totalHours; h++) {
    const hourStart = startTs + h * HOUR_MS;
    const factor = seasonalFactor(hourStart);

    for (const c of corridors) {
      const lambdaHour = (c.dailyVolumeUsd / c.avgTicketUsd / 24) * factor;
      const n = rng.poisson(lambdaHour);
      const pBaseToQuote = (1 + c.imbalance) / 2;

      for (let i = 0; i < n; i++) {
        const notionalUsd = rng.lognormalWithMean(c.avgTicketUsd, c.tailSigma);
        const baseToQuote = rng.bernoulli(pBaseToQuote);
        events.push({
          ts: hourStart + Math.floor(rng.uniform() * HOUR_MS),
          corridorId: c.id,
          receive: baseToQuote ? c.base : c.quote,
          pay: baseToQuote ? c.quote : c.base,
          notionalUsd,
        });
      }
    }
  }

  // Stable sort on the timestamp: events within the same hour are generated out of
  // order. `Array.prototype.sort` has been stable since ES2019, so insertion order
  // breaks ties — determinism is preserved.
  events.sort((a, b) => a.ts - b.ts);
  return events;
}
