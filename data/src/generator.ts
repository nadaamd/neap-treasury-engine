/**
 * Générateur de flux de paiement — SPEC §17.
 *
 * Processus de Poisson composé à intensité saisonnière :
 *   arrivées  N_h ~ Poisson( lambda_daily / 24 · s_hour · s_dow · s_dom )
 *   montants  X_i ~ LogNormal de moyenne `avgTicketUsd` et de forme `tailSigma`
 *   direction Bernoulli pilotée par le déséquilibre du corridor
 *
 * Déterminisme : un seul Rng, parcouru dans un ordre fixe (heure croissante, puis
 * corridors dans l'ordre du tableau). Même seed ⇒ même sortie, octet pour octet.
 */

import { Rng } from './random.ts';
import { seasonalFactor } from './seasonality.ts';
import type { CorridorSpec, FlowEvent } from './types.ts';

const HOUR_MS = 3_600_000;

export interface GenerateOptions {
  readonly seed: number;
  /** Début de la simulation, aligné sur une heure UTC. */
  readonly startTs: number;
  readonly days: number;
  readonly corridors: readonly CorridorSpec[];
}

export function generateFlows(opts: GenerateOptions): FlowEvent[] {
  const { seed, startTs, days, corridors } = opts;
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`days doit être un entier positif, reçu ${days}`);
  }
  if (startTs % HOUR_MS !== 0) {
    throw new RangeError('startTs doit être aligné sur une heure UTC');
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

  // Tri stable sur l'horodatage : les événements d'une même heure sont générés
  // dans le désordre. `Array.prototype.sort` est stable depuis ES2019, l'ordre
  // d'insertion départage donc les ex æquo — le déterminisme est préservé.
  events.sort((a, b) => a.ts - b.ts);
  return events;
}
