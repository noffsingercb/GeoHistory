import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { getTimeline, renderMarkdown, DEFAULT_CONFIG, ENGINE_VERSION, type TimelineInput } from './core';

// ===================== geohistory JSON API (v1) =====================
// A thin, dependency-free HTTP wrapper (Node built-in http) around the
// deterministic timeline engine (core.ts) and full-text search, reading the
// local events.sqlite strictly read-only.
//
// Exactly four routes exist, all under /v1:
//   GET  /v1/health
//   GET  /v1/meta
//   GET  /v1/search?q=<term>&limit=<n>
//   POST /v1/timeline            (?format=markdown for Markdown)
// Everything else 404s.
//
//   npm run serve            # http://localhost:8787  (override with PORT)
//
// Environment:
//   PORT               listen port (default 8787)
//   GEOHISTORY_DB      path to events.sqlite (default alongside this file)
//   ALLOWED_ORIGIN     comma-separated CORS allowlist, e.g.
//                        ALLOWED_ORIGIN=https://circa.example,https://www.circa.example
//                      When unset and NODE_ENV !== 'production', local dev
//                      origins are allowed so `npm run dev` works out of the box.
//   RATE_LIMIT_MAX     requests per IP per window (default 60)
//   RATE_LIMIT_WINDOW  window in seconds (default 60)

const SERVICE = 'geohistory-api';
const API_VERSION = 'v1';
const SERVICE_VERSION = '0.7.0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.GEOHISTORY_DB ?? join(__dirname, 'events.sqlite');
const PORT = parseInt(process.env.PORT ?? '8787', 10);

const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES ?? '65536', 10); // 64 KB
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS ?? '15000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? '60', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW ?? '60', 10) * 1000;

const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEV_ORIGINS = [
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:4173', 'http://127.0.0.1:4173',
];
const ALLOW_DEV_ORIGINS = ALLOWED_ORIGINS.length === 0 && !IS_PROD;

// ===================== Database (read-only) =====================

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
db.pragma('trusted_schema = OFF');

// ===================== Responses =====================

const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  Vary: 'Origin',
};

/** Returns the value to echo in Access-Control-Allow-Origin, or null if the origin is refused. */
function resolveOrigin(origin: string | undefined): string | null {
  if (!origin) return null; // non-browser client (curl); no CORS headers needed
  if (ALLOWED_ORIGINS.includes('*')) return '*';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (ALLOW_DEV_ORIGINS && DEV_ORIGINS.includes(origin)) return origin;
  return null;
}

function corsHeaders(allowOrigin: string | null): Record<string, string> {
  if (!allowOrigin) return {};
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  allowOrigin: string | null = null,
  extra: Record<string, string> = {},
): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...BASE_HEADERS,
    ...corsHeaders(allowOrigin),
    ...extra,
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(
  res: http.ServerResponse,
  status: number,
  text: string,
  type = 'text/plain; charset=utf-8',
  allowOrigin: string | null = null,
): void {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': type,
    ...BASE_HEADERS,
    ...corsHeaders(allowOrigin),
  });
  res.end(text);
}

// ===================== Logging (no bodies, truncated IPs) =====================

/** Coarsen a client IP before it reaches a log line: IPv4 loses its last octet, IPv6 keeps /48. */
function truncateIp(raw: string | undefined): string {
  if (!raw) return 'unknown';
  const ip = raw.replace(/^::ffff:/, '');
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : 'unknown';
  }
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  return 'unknown';
}

/** Never logs request bodies, query values, or full addresses. */
function logAccess(method: string, path: string, status: number, ms: number, ip: string): void {
  console.log(`${new Date().toISOString()} ${method} ${path} ${status} ${ms}ms ip=${ip}`);
}

// ===================== Per-IP rate limit (in-memory, fixed window) =====================

const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string): { ok: boolean; retryAfter: number; remaining: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    buckets.set(key, b);
  }
  b.count++;
  const retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  return {
    ok: b.count <= RATE_LIMIT_MAX,
    retryAfter,
    remaining: Math.max(0, RATE_LIMIT_MAX - b.count),
  };
}

// Sweep expired buckets so a burst of unique IPs cannot grow the map forever.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, RATE_LIMIT_WINDOW_MS).unref();

// ===================== Input validation =====================

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
      return;
    }
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MAX_SEGMENTS_ACCEPTED = 40; // engine also caps via config.maxSegments

function validateInput(body: any): TimelineInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Body must be a JSON object.');
  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    throw new Error('segments must be a non-empty array.');
  }
  if (body.segments.length > MAX_SEGMENTS_ACCEPTED) {
    throw new Error(`segments must contain at most ${MAX_SEGMENTS_ACCEPTED} entries.`);
  }
  body.segments.forEach((seg: any, i: number) => {
    if (!seg || typeof seg !== 'object') throw new Error(`segments[${i}] must be an object.`);
    const p = seg.place;
    if (!p || typeof p !== 'object') throw new Error(`segments[${i}].place is required.`);
    if (typeof p.lat !== 'number' || !isFinite(p.lat) || typeof p.lng !== 'number' || !isFinite(p.lng)) {
      throw new Error(`segments[${i}].place.lat and .lng must be finite numbers.`);
    }
    if (p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180) {
      throw new Error(`segments[${i}].place.lat/.lng are out of range.`);
    }
    if (typeof seg.start !== 'string' || !seg.start.trim()) {
      throw new Error(`segments[${i}].start must be a non-empty date string.`);
    }
    if (seg.end != null && typeof seg.end !== 'string') {
      throw new Error(`segments[${i}].end must be a string when provided.`);
    }
    if (seg.label != null && typeof seg.label !== 'string') {
      throw new Error(`segments[${i}].label must be a string when provided.`);
    }
  });
  if (body.person != null && typeof body.person !== 'string') throw new Error('person must be a string.');
  if (body.config != null && (typeof body.config !== 'object' || Array.isArray(body.config))) {
    throw new Error('config must be an object.');
  }
  return body as TimelineInput;
}

// ===================== Queries =====================

const searchStmt = db.prepare(`
  SELECT e.id, e.title, e.blurb, e.date_start, e.date_precision, e.category,
         e.lat, e.lng, e.scope, e.significance, e.notability, e.source_url
  FROM events_fts f
  JOIN events e ON e.rowid = f.rowid
  WHERE events_fts MATCH ?
  ORDER BY e.notability DESC, e.date_start ASC
  LIMIT ?
`);

function datasetMeta(): Record<string, unknown> {
  const meta: Record<string, string> = {};
  try {
    for (const r of db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>) {
      meta[r.key] = r.value;
    }
  } catch { /* meta table may be absent on old DBs */ }
  const total = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c as number;
  return { totalEvents: total, ...meta };
}

/**
 * events.sqlite is a LAYERED artifact, and meta.dataset_version names only the
 * bottom layer (the modal ingest_version). A single file can carry an ingest
 * label, a scoring pass, a reach pass, classification passes, and any number of
 * prunes -- all of which change what a client gets back while leaving
 * dataset_version untouched. Reading 'dump-v0.5' off a deployed image therefore
 * says almost nothing about what is in it, which matters once Step 1.4 bakes
 * the file into a read-only image layer.
 *
 * The id is DERIVED from what the DB records about itself rather than
 * hand-maintained, so it cannot go stale the way the hardcoded engine string
 * did. Note that `npm run score` restamps dataset_version and so changes this
 * id -- correct, because that is a different artifact.
 *
 * The prune list below is the one part of this that IS hand-maintained, and it
 * has already been wrong once: prune-seed-dupes.ts wrote no stamp at all, so a
 * database that had been through three prunes reported 'prune2'. Any new prune
 * script must both write a meta key and be added here, or it stays invisible.
 */
function datasetBuild(m: Record<string, unknown>): {
  id: string;
  layers: { ingest: string | null; scoring: string | null; reach: string | null; prunes: string[] };
} {
  const str = (k: string): string | null => (typeof m[k] === 'string' && m[k] ? (m[k] as string) : null);
  const layers = {
    ingest: str('dataset_version'),
    scoring: str('scoring_version'),
    reach: str('reach_version'),
    // Full stamps, e.g. 'election<0.25 removed 1047 at <ISO>'. Order is fixed so
    // the id is stable for a given file.
    prunes: [str('last_prune'), str('last_series_prune'), str('last_dupe_prune')].filter(
      (v): v is string => v !== null,
    ),
  };
  const id = [
    layers.ingest ?? 'unknown-ingest',
    layers.scoring ?? 'unscored',
    layers.reach ?? 'no-reach',
    layers.prunes.length > 0 ? `prune${layers.prunes.length}` : 'unpruned',
  ].join('+');
  return { id, layers };
}

/**
 * GET /v1/meta payload. Publishing DEFAULT_CONFIG is the point of this route:
 * clients (Circa) can read the engine's own tuning defaults instead of
 * restating them, so a server-side retune propagates without a client release.
 */
function metaPayload(): Record<string, unknown> {
  const m = datasetMeta();
  const build = datasetBuild(m);
  return {
    service: SERVICE,
    apiVersion: API_VERSION,
    serviceVersion: SERVICE_VERSION,
    engine: ENGINE_VERSION,
    datasetVersion: (m as any).dataset_version ?? null,
    datasetBuild: build.id,
    datasetLayers: build.layers,
    dataset: m,
    defaults: DEFAULT_CONFIG,
    limits: {
      maxBodyBytes: MAX_BODY_BYTES,
      maxSegments: MAX_SEGMENTS_ACCEPTED,
      searchLimitMax: 100,
      rateLimit: { max: RATE_LIMIT_MAX, windowSeconds: RATE_LIMIT_WINDOW_MS / 1000 },
    },
  };
}

// ===================== Router =====================

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const method = req.method ?? 'GET';
  const origin = req.headers.origin;
  const ip = truncateIp(req.socket.remoteAddress ?? undefined);
  let routePath = '-';

  const finish = (status: number) => logAccess(method, routePath, status, Date.now() - started, ip);

  // Per-request timeout: a slow or stalled request is closed rather than held open.
  req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); });
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.writableEnded) {
      sendJson(res, 503, { error: 'Request timed out.' });
      finish(503);
    }
  });

  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    let path = url.pathname;
    while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    routePath = path;

    // 1. Origin gate. A browser request from an unlisted origin is refused outright.
    const allowOrigin = resolveOrigin(origin);
    if (origin && !allowOrigin) {
      sendJson(res, 403, { error: 'Origin not allowed.' });
      return finish(403);
    }

    // 2. Preflight.
    if (method === 'OPTIONS') {
      res.writeHead(204, { ...BASE_HEADERS, ...corsHeaders(allowOrigin) });
      res.end();
      return finish(204);
    }

    // 3. Rate limit.
    const rl = rateLimit(req.socket.remoteAddress ?? 'unknown');
    if (!rl.ok) {
      sendJson(res, 429, { error: 'Rate limit exceeded.' }, allowOrigin, {
        'Retry-After': String(rl.retryAfter),
      });
      return finish(429);
    }

    // 4. Routes — exactly four, all under /v1.
    if (method === 'GET' && path === '/v1/health') {
      sendJson(res, 200, { ok: true }, allowOrigin);
      return finish(200);
    }

    if (method === 'GET' && path === '/v1/meta') {
      sendJson(res, 200, metaPayload(), allowOrigin);
      return finish(200);
    }

    if (method === 'GET' && path === '/v1/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q) {
        sendJson(res, 400, { error: 'Missing ?q= search term.' }, allowOrigin);
        return finish(400);
      }
      if (q.length > 200) {
        sendJson(res, 400, { error: 'Search term is too long.' }, allowOrigin);
        return finish(400);
      }
      let limit = parseInt(url.searchParams.get('limit') ?? '25', 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 25;
      limit = Math.min(limit, 100);
      try {
        const results = searchStmt.all(q, limit);
        sendJson(res, 200, { query: q, count: results.length, results }, allowOrigin);
        return finish(200);
      } catch (e: any) {
        sendJson(res, 400, { error: `Invalid search query: ${e?.message ?? e}` }, allowOrigin);
        return finish(400);
      }
    }

    if (method === 'POST' && path === '/v1/timeline') {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (e: any) {
        const status = e?.status === 413 ? 413 : 400;
        sendJson(res, status, { error: e?.message ?? 'Could not read request body.' }, allowOrigin);
        return finish(status);
      }

      let parsed: any;
      try { parsed = JSON.parse(raw || '{}'); }
      catch {
        sendJson(res, 400, { error: 'Request body is not valid JSON.' }, allowOrigin);
        return finish(400);
      }

      let input: TimelineInput;
      try { input = validateInput(parsed); }
      catch (e: any) {
        sendJson(res, 400, { error: e?.message ?? 'Invalid input.' }, allowOrigin);
        return finish(400);
      }

      let result;
      try { result = getTimeline(db, input); }
      catch (e: any) {
        sendJson(res, 400, { error: `Could not build timeline: ${e?.message ?? e}` }, allowOrigin);
        return finish(400);
      }

      const wantsMd = url.searchParams.get('format') === 'markdown'
        || (req.headers.accept ?? '').includes('text/markdown');
      if (wantsMd) {
        sendText(res, 200, renderMarkdown(result), 'text/markdown; charset=utf-8', allowOrigin);
        return finish(200);
      }
      sendJson(res, 200, result, allowOrigin);
      return finish(200);
    }

    // 5. Catch-all. No root document, no directory listing, no hints beyond the version prefix.
    sendJson(res, 404, { error: 'Not found.', apiVersion: API_VERSION }, allowOrigin);
    return finish(404);
  } catch (e: any) {
    // Error text is deliberately generic; details stay in the server log.
    console.error(`${new Date().toISOString()} error ${method} ${routePath}: ${e?.message ?? e}`);
    sendJson(res, 500, { error: 'Internal server error.' });
    return finish(500);
  }
});

server.headersTimeout = REQUEST_TIMEOUT_MS + 5000;
server.requestTimeout = REQUEST_TIMEOUT_MS + 5000;

function shutdown(signal: string): void {
  console.log(`${signal} received, closing.`);
  clearInterval(sweeper);
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  const m = datasetMeta();
  console.log(`${SERVICE} listening on http://localhost:${PORT} (${API_VERSION})`);
  console.log(`  engine   ${ENGINE_VERSION}`);
  console.log(`  build    ${datasetBuild(m).id} - ${Number(m.totalEvents).toLocaleString()} events`);
  console.log(`  routes:  GET /v1/health  GET /v1/meta  GET /v1/search  POST /v1/timeline`);
  console.log(`  origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : (ALLOW_DEV_ORIGINS ? 'dev localhost only (ALLOWED_ORIGIN unset)' : 'none — set ALLOWED_ORIGIN')}`);
});
