/**
 * Dashboard server.
 *
 * `node:http` and nothing else. On demo day, a dependency chain that refuses to install
 * costs more than everything it would have brought.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { buildEpisode, DEFAULT_PARAMS } from './src/episode.ts';
import { marketPayload, treasuryPayload } from './src/creEndpoints.ts';
import type { EpisodeParams } from './src/episode.ts';
import type { Currency } from '../data/src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const ROOT = join(HERE, '..');
const PORT = Number(process.env.PORT ?? 5173);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function num(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function paramsFrom(url: URL): EpisodeParams {
  const shockAt = url.searchParams.get('shockAt');
  return {
    seed: Math.trunc(num(url.searchParams.get('seed'), DEFAULT_PARAMS.seed)),
    // Bounded: an episode is computed on demand and must not be able to block the
    // server during a demo.
    days: Math.min(Math.max(Math.trunc(num(url.searchParams.get('days'), DEFAULT_PARAMS.days)), 1), 10),
    kappa: Math.min(Math.max(num(url.searchParams.get('kappa'), DEFAULT_PARAMS.kappa), 0), 5),
    etaScale: Math.min(Math.max(num(url.searchParams.get('eta'), DEFAULT_PARAMS.etaScale), 0.1), 10),
    breachCost: Math.min(
      Math.max(num(url.searchParams.get('breach'), DEFAULT_PARAMS.breachCost), 1_000),
      50_000_000,
    ),
    shockAt: shockAt === null || shockAt === '' ? null : Math.trunc(Number(shockAt)),
    shockCurrency: (url.searchParams.get('shockCurrency') ?? 'BRL') as Currency,
    shockAmount: Math.max(num(url.searchParams.get('shockAmount'), DEFAULT_PARAMS.shockAmount), 0),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/episode') {
      const started = Date.now();
      const episode = buildEpisode(paramsFrom(url));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...episode, computeMs: Date.now() - started }));
      return;
    }

    // Endpoints consumed by the confidential handler during simulation.
    if (url.pathname === '/api/cre/treasury') {
      const expected = process.env.SECRET_TREASURY_API_TOKEN ?? 'simulation-token';
      const body = treasuryPayload(req.headers.authorization, expected);
      if (body === null) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"missing or invalid token"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/cre/market') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(marketPayload());
      return;
    }

    if (url.pathname === '/api/backtest') {
      try {
        const raw = await readFile(join(ROOT, 'results/backtest.json'), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(raw);
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"no backtest — run node engine/scripts/backtest.ts --json results/backtest.json"}');
      }
      return;
    }

    // The landing page persuades, the dashboard is for working: two surfaces, two
    // addresses. `/app` without an extension is an address you can say out loud.
    const requested =
      url.pathname === '/' ? '/index.html' : url.pathname === '/app' ? '/app.html' : url.pathname;
    // Elementary safety: only what lives under public/ is served.
    const target = join(PUBLIC, requested);
    if (!target.startsWith(PUBLIC)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

/**
 * A busy port is the most mundane error in development, and the stack trace Node prints
 * by default helps nobody. Say what is happening and how to get out of it — including
 * five minutes before a demo.
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`  · to free it:          pkill -f "node app/server.ts"`);
    console.error(`  · to use another port: PORT=5174 npm run dev`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`NEAP — dashboard on http://localhost:${PORT}`);
});
