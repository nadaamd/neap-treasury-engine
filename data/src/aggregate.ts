/** Agrégation des événements de flux en flux nets par devise et par intervalle. */

import type { Currency, FlowBucket, FlowEvent, NetByCurrency } from './types.ts';

const CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'GBP', 'BRL'];

function emptyNet(): NetByCurrency {
  return { USD: 0, EUR: 0, GBP: 0, BRL: 0 };
}

/**
 * Regroupe les flux en intervalles réguliers.
 *
 * Les intervalles vides sont conservés : une série de flux nets doit être régulièrement
 * échantillonnée pour que l'autocorrélation et la volatilité aient un sens. Supprimer
 * les trous décalerait les retards et fausserait la saisonnalité mesurée.
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

/** Série du volume brut (somme des montants) par intervalle — support des tests de calibration. */
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
