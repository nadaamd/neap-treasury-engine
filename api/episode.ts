/**
 * Fonction serverless : un épisode à la demande.
 *
 * Le serveur de développement est un processus permanent ; Vercel n'en héberge pas.
 * Seul ce point d'entrée devient une fonction, parce que lui seul calcule quelque chose —
 * la résolution des bandes prend quelques centaines de millisecondes et dépend des
 * curseurs. Le reste du site est statique, y compris les résultats du backtest, qui ne
 * changent qu'au moment où on relance `npm run backtest`.
 */

import { buildEpisode, DEFAULT_PARAMS } from '../app/src/episode.ts';
import type { EpisodeParams } from '../app/src/episode.ts';
import type { Currency } from '../data/src/types.ts';

function num(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Les bornes protègent la fonction : une requête ne doit pas pouvoir choisir son coût. */
function paramsFrom(url: URL): EpisodeParams {
  const shockAt = url.searchParams.get('shockAt');
  return {
    seed: Math.trunc(num(url.searchParams.get('seed'), DEFAULT_PARAMS.seed)),
    days: clamp(Math.trunc(num(url.searchParams.get('days'), DEFAULT_PARAMS.days)), 1, 10),
    kappa: clamp(num(url.searchParams.get('kappa'), DEFAULT_PARAMS.kappa), 0, 5),
    etaScale: clamp(num(url.searchParams.get('eta'), DEFAULT_PARAMS.etaScale), 0.1, 10),
    breachCost: clamp(num(url.searchParams.get('breach'), DEFAULT_PARAMS.breachCost), 1_000, 50_000_000),
    shockAt: shockAt === null || shockAt === '' ? null : Math.trunc(Number(shockAt)),
    shockCurrency: (url.searchParams.get('shockCurrency') ?? 'BRL') as Currency,
    shockAmount: Math.max(num(url.searchParams.get('shockAmount'), DEFAULT_PARAMS.shockAmount), 0),
  };
}

export function GET(request: Request): Response {
  const started = Date.now();
  const episode = buildEpisode(paramsFrom(new URL(request.url)));
  return new Response(JSON.stringify({ ...episode, computeMs: Date.now() - started }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Un épisode est déterministe : mêmes paramètres, même réponse. Le cache de bord
      // évite de recalculer les mêmes bandes pour chaque visiteur.
      'cache-control': 'public, s-maxage=86400, stale-while-revalidate=604800',
    },
  });
}
