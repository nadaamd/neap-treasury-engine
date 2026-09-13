/**
 * Serverless function: one episode on demand.
 *
 * The development server is a long-lived process; Vercel hosts none. Only this endpoint
 * becomes a function, because it is the only one that computes anything — solving the
 * bands takes a few hundred milliseconds and depends on the sliders. The rest of the site
 * is static, including the backtest results, which only change when `npm run backtest` is
 * re-run.
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

/** The bounds protect the function: a request must not be able to choose its own cost. */
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
      // An episode is deterministic: same parameters, same response. The edge cache
      // avoids recomputing the same bands for every visitor.
      'cache-control': 'public, s-maxage=86400, stale-while-revalidate=604800',
    },
  });
}
