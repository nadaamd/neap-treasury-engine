/**
 * Serveur du tableau de bord.
 *
 * `node:http` et rien d'autre. Le jour de la démonstration, une chaîne de dépendances
 * qui refuse de s'installer coûte plus cher que tout ce qu'elle aurait apporté.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { buildEpisode, DEFAULT_PARAMS } from './src/episode.ts';
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
    // Borné : un épisode se calcule à la demande, il ne doit pas pouvoir bloquer le
    // serveur pendant une démonstration.
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

    if (url.pathname === '/api/backtest') {
      try {
        const raw = await readFile(join(ROOT, 'results/backtest.json'), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(raw);
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"backtest absent — lancer node engine/scripts/backtest.ts --json results/backtest.json"}');
      }
      return;
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    // Sécurité élémentaire : on ne sert que ce qui est sous public/.
    const target = join(PUBLIC, requested);
    if (!target.startsWith(PUBLIC)) {
      res.writeHead(403).end('interdit');
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('introuvable');
  }
});

/**
 * Un port occupé est le cas d'erreur le plus banal en développement, et la trace de pile
 * que Node produit par défaut n'aide personne. On dit ce qui se passe et comment s'en
 * sortir — y compris cinq minutes avant une démonstration.
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Le port ${PORT} est déjà occupé.`);
    console.error(`  · pour libérer :        pkill -f "node app/server.ts"`);
    console.error(`  · pour un autre port :  PORT=5174 npm run dev`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`FLOAT — tableau de bord sur http://localhost:${PORT}`);
});
