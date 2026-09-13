/** Aggregation of flow events into net flows per currency and per bucket. */

import type { Currency, FlowBucket, FlowEvent, NetByCurrency } from './types.ts';

const CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'GBP', 'BRL'];

function emptyNet(): NetByCurrency {
  return { USD: 0, EUR: 0, GBP: 0, BRL: 0 };
}

/**
 * Groups flows into regular buckets.
 *
 * Empty buckets are kept: a net flow series must be regularly sampled for
 * autocorrelation and volatility to mean anything. Dropping the gaps would shift the
 * lags and distort the measured seasonality.
 */
export function bucketize(
  events: readonly FlowEvent[],
  startTs: number,
  bucketMs: number,
  bucketCount: number,
): FlowBucket[] {
  const buckets: FlowBucket[] = [];
  const nets: NetByCurrency[] = [];
  const counts = new Array<number>(bucketCount).fill(0);

  for (let i = 0; i < bucketCount; i++) nets.push(emptyNet());

  for (const e of events) {
    const idx = Math.floor((e.ts - startTs) / bucketMs);
    if (idx < 0 || idx >= bucketCount) continue;
    const net = nets[idx]!;
    net[e.receive] += e.notionalUsd;
    net[e.pay] -= e.notionalUsd;
    counts[idx] = counts[idx]! + 1;
  }

  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ startTs: startTs + i * bucketMs, net: nets[i]!, count: counts[i]! });
  }
  return buckets;
}

/** Gross volume series (sum of amounts) per bucket — support for the calibration tests. */
export function grossVolumeSeries(
  events: readonly FlowEvent[],
  startTs: number,
  bucketMs: number,
  bucketCount: number,
): number[] {
  const out = new Array<number>(bucketCount).fill(0);
  for (const e of events) {
    const idx = Math.floor((e.ts - startTs) / bucketMs);
    if (idx >= 0 && idx < bucketCount) out[idx] = out[idx]! + e.notionalUsd;
  }
  return out;
}

export { CURRENCIES };
