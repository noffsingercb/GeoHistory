import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  getTimeline,
  renderMarkdown,
  parseDate,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  ABSOLUTE_MIN_FLOOR,
  MAX_CANDIDATE_ROWS,
  type TimelineInput,
} from './core';
import {
  validateVote,
  forwardVote,
  feedbackRateLimit,
  stopFeedbackLimiter,
  feedbackCounters,
  FEEDBACK_CONFIGURED,
} from './feedback';
import {
  createRateLimiter,
  getClientIp,
  rateLimitKey,
  truncateIp,
  TRUSTED_PROXY_HOPS,
} from './net';
import { validateConfig, CONFIG_BOUNDS } from './validate-config';

// ===================== geohistory JSON API (v1) =====================
// A thin, dependency-free HTTP wrapper (Node built-in http) around the
// deterministic timeline engine (core.ts) and full-text search, reading the
// local events.sqlite strictly read-only.
//
// Deployed as a Docker web service on Render (see render.yaml), which is the
// only live API point. Render terminates TLS and proxies to this process, which
// is why TRUSTED_PROXY_HOPS exists and defaults to 1 -- see net.ts.
//
// Exactly five routes exist, all under /v1:
//   GET  /v1/health
//   GET  /v1/meta
//   GET  /v1/search?q=<term>&limit=<n>
//   POST /v1/timeline            (?format=markdown for Markdown)
//   POST /v1/feedback            (thumbs up/down; forwarded, never stored here)
// Everything else 404s.
//
// /v1/feedback is the one route that talks to the outside world. It still does
// not write anything locally -- the database stays read-only -- it validates a
// coarsened vote and hands it to a Notion Worker. See feedback.ts.
//
//   npm run serve            # http://localhost:8787  (override with PORT)
//
// Environment:
//   PORT                    listen port (default 8787)
//   GEOHISTORY_DB           path to events.sqlite (default alongside this file)
//   ALLOWED_ORIGIN          comma-separated CORS allowlist, e.g.
//                             ALLOWED_ORIGIN=https://circa-2cg.pages.dev
//   ALLOW_DEV_ORIGINS       'true' to also accept localhost:5173/4173. OFF by
//                           default, and ignored entirely when
//                           NODE_ENV=production. See the note below.
//   ALLOW_NO_ORIGIN_POST    'true' to accept POSTs with no Origin header once
//                           ALLOWED_ORIGIN is set (curl, CI, the Markdown CLI)
//   TRUSTED_PROXY_HOPS      proxy hops in front of this process (Render: 1)
//   RATE_LIMIT_MAX          requests per client per window (default 60)
//   RATE_LIMIT_WINDOW       window in seconds (default 60)
//   MAX_RATE_LIMIT_KEYS     bucket ceiling before overflow sharing (default 10000)
//   MAX_CONCURRENT_TIMELINES  in-flight POST /v1/timeline ceiling (default 4)
//   MAX_SEGMENT_SPAN_YEARS  longest single segment accepted (default 300)
//   MAX_TOTAL_SPAN_YEARS    sum of all segment spans accepted (default 3000)
//   CIRCA_FEEDBACK_WEBHOOK_URL / CIRCA_FEEDBACK_SECRET / FEEDBACK_RATE_LIMIT_MAX
//                           see feedback.ts; when unset, votes are accepted and dropped

const SERVICE = 'geohistory-api';
const API_VERSION = 'v1';
const SERVICE_VERSION = '0.7.1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.GEOHISTORY_DB ?? join(__dirname, 'events.sqlite');
const PORT = parseInt(process.env.PORT ?? '8787', 10);

const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES ?? '65536', 10); // 64 KB
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS ?? '15000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? '60', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW ?? '60', 10) * 1000;

/**
 * Ceiling on simultaneous timeline builds.
 *
 * The per-client rate limit bounds how often ONE caller can ask; it does
 * nothing about many callers arriving at once, and a timeline is the only
 * expensive thing this service does. Four is chosen against the deployment
 * rather than in the abstract: Render's free plan is a single shared CPU with
 * 512 MB, so the fifth concurrent build would not be slow, it would be the one
 * that pushes the instance into swap and takes the other four down with it.
 *
 * Answering 503 immediately is the honest response to "we cannot do this now" --
 * far better than queueing, which converts a load spike into a pile of requests
 * all timing out at 15s having consumed memory the whole time.
 */
const MAX_CONCURRENT_TIMELINES = parseInt(process.env.MAX_CONCURRENT_TIMELINES ?? '4', 10);

const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEV_ORIGINS = [
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:4173', 'http://127.0.0.1:4173',
];

/**
 * Local dev origins are now OPT-IN, and doubly gated.
 *
 * This used to be `ALLOWED_ORIGINS.length === 0 && !IS_PROD`, which reads as
 * "only in development" and was not. render.yaml never set NODE_ENV, and
 * ALLOWED_ORIGIN is declared there with `sync: false` -- meaning it is unset
 * until somebody fills it in on the dashboard. Both conditions were therefore
 * true on the live service, and the deployed API accepted browser requests from
 * http://localhost:5173. Any page on any machine could point a dev build at
 * production and be inside the CORS allowlist.
 *
 * It was a real convenience during the feedback and share work and it has
 * served its purpose. Now it requires an explicit ALLOW_DEV_ORIGINS=true AND a
 * non-production NODE_ENV, so no combination of *missing* configuration can
 * re-open it. render.yaml also sets NODE_ENV=production explicitly, so the
 * second gate does not depend on a default either.
 */
const ALLOW_DEV_ORIGINS = process.env.ALLOW_DEV_ORIGINS === 'true' && !IS_PROD;

/**
 * Whether a POST with no Origin header at all is accepted once an allowlist is
 * configured.
 *
 * A browser always sends Origin on a cross-origin POST, so an absent Origin
 * means a non-browser client. Previously the origin gate read
 * `if (origin && !allowOrigin)`, so those requests skipped the check entirely
 * and the allowlist was advisory for anything that simply omitted the header.
 * That is now explicit rather than incidental: refused by default in a
 * configured deployment, with an escape hatch for curl, CI and the Markdown CLI.
 */
const ALLOW_NO_ORIGIN_POST = process.env.ALLOW_NO_ORIGIN_POST === 'true';

const MAX_SEGMENT_SPAN_YEARS = parseInt(process.env.MAX_SEGMENT_SPAN_YEARS ?? '300', 10);
const MAX_TOTAL_SPAN_YEARS = parseInt(process.env.MAX_TOTAL_SPAN_YEARS ?? '3000', 10);

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

/** 204 has no body by definition, so it cannot go through sendJson. */
function sendNoContent(res: http.ServerResponse, allowOrigin: string | null = null): void {
  if (res.writableEnded) return;
  res.writeHead(204, { ...BASE_HEADERS, ...corsHeaders(allowOrigin) });
  res.end();
}

// ===================== Logging (no bodies, truncated IPs) =====================

/** Never logs request bodies, query values, or full addresses. */
function logAccess(method: string, path: string, status: number, ms: number, ip: string): void {
  console.log(`${new Date().toISOString()} ${method} ${path} ${status} ${ms}ms ip=${ip}`);
}

// ===================== Per-client rate limit =====================

// Bucket map, keying and sweep live in net.ts and are shared with the feedback
// limiter. Keys are the DERIVED client address (IPv6 collapsed to /64), not the
// socket peer -- behind Render's proxy the socket peer is the same value for
// every visitor on earth, so the old limiter granted one shared 60/min budget
// to the entire internet and per-attacker limiting did not exist at all.
const limiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
});

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

/** Earliest year the dataset covers, with room to spare; the ingester skips BCE. */
const MIN_YEAR_ACCEPTED = 1;
const MAX_YEAR_ACCEPTED = new Date().getUTCFullYear() + 1;

function validateInput(body: any): TimelineInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Body must be a JSON object.');
  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    throw new Error('segments must be a non-empty array.');
  }
  if (body.segments.length > MAX_SEGMENTS_ACCEPTED) {
    throw new Error(`segments must contain at most ${MAX_SEGMENTS_ACCEPTED} entries.`);
  }

  // Total work is roughly (segments x years spanned), so bounding the segment
  // count alone was never enough: 40 segments each spanning the year 1 to now
  // is a legal request under the old checks and a very expensive one. The
  // date strings were previously only checked for being non-empty strings --
  // whether they parsed at all, what years they resolved to, and whether end
  // came after start were all left to the engine.
  let totalSpanYears = 0;

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
    if (seg.label != null && seg.label.length > 200) {
      throw new Error(`segments[${i}].label must be at most 200 characters.`);
    }
    if (typeof p.name === 'string' && p.name.length > 300) {
      throw new Error(`segments[${i}].place.name must be at most 300 characters.`);
    }

    // parseDate is the engine's own parser, so a request that passes here
    // cannot fail differently inside getTimeline.
    let lo: { loISO: string; hiISO: string };
    try {
      lo = parseDate(seg.start);
    } catch {
      throw new Error(`segments[${i}].start is not a parseable date.`);
    }
    let hi = lo;
    if (seg.end != null && seg.end.trim()) {
      try {
        hi = parseDate(seg.end);
      } catch {
        throw new Error(`segments[${i}].end is not a parseable date.`);
      }
    }

    const startYear = parseInt(lo.loISO.slice(0, 4), 10);
    const endYear = parseInt(hi.hiISO.slice(0, 4), 10);
    if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) {
      throw new Error(`segments[${i}] has an unresolvable year.`);
    }
    if (endYear < startYear) {
      throw new Error(`segments[${i}].end must not be before .start.`);
    }
    if (startYear < MIN_YEAR_ACCEPTED || endYear > MAX_YEAR_ACCEPTED) {
      throw new Error(
        `segments[${i}] must fall between year ${MIN_YEAR_ACCEPTED} and ${MAX_YEAR_ACCEPTED}.`,
      );
    }

    const span = endYear - startYear + 1;
    if (span > MAX_SEGMENT_SPAN_YEARS) {
      throw new Error(
        `segments[${i}] spans ${span} years; the maximum is ${MAX_SEGMENT_SPAN_YEARS}.`,
      );
    }
    totalSpanYears += span;
  });

  if (totalSpanYears > MAX_TOTAL_SPAN_YEARS) {
    throw new Error(
      `segments span ${totalSpanYears} years in total; the maximum is ${MAX_TOTAL_SPAN_YEARS}.`,
    );
  }

  if (body.person != null && typeof body.person !== 'string') throw new Error('person must be a string.');
  if (body.person != null && body.person.length > 200) {
    throw new Error('person must be at most 200 characters.');
  }

  // config is allowlisted and clamped rather than shape-checked. It is NOT
  // dropped: Circa's sparsity retry legitimately sends scopeFloor.local. See
  // validate-config.ts for the bounds and the reasoning.
  const config = validateConfig(body.config);

  return {
    person: body.person ?? undefined,
    segments: body.segments,
    ...(config ? { config } : {}),
  } as TimelineInput;
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
 * says almost nothing about what is in it, which matters once the file is baked
 * into a read-only image layer.
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
 *
 * v0.6 added two more prune-family passes that also mutate what a client gets
 * back -- prune-media.ts (media/franchise defect removal) and
 * merge-universal-dupes.ts (universal/global duplicate merge) -- and both were
 * missing from this list the same way prune-seed-dupes.ts once was. Counted
 * here now so a v0.6 build reports its true prune depth instead of silently
 * undercounting it.
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
    prunes: [
      str('last_prune'),
      str('last_series_prune'),
      str('last_dupe_prune'),
      str('last_media_prune'),
      str('last_universal_merge'),
    ].filter((v): v is string => v !== null),
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
 *
 * configBounds is published for the same reason. A client that knows the
 * accepted range can keep itself inside it rather than discovering a clamp as a
 * 400 in production.
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
    configBounds: CONFIG_BOUNDS,
    limits: {
      maxBodyBytes: MAX_BODY_BYTES,
      maxSegments: MAX_SEGMENTS_ACCEPTED,
      maxSegmentSpanYears: MAX_SEGMENT_SPAN_YEARS,
      maxTotalSpanYears: MAX_TOTAL_SPAN_YEARS,
      searchLimitMax: 100,
      absoluteMinFloor: ABSOLUTE_MIN_FLOOR,
      maxCandidateRows: MAX_CANDIDATE_ROWS,
      maxConcurrentTimelines: MAX_CONCURRENT_TIMELINES,
      rateLimit: { max: RATE_LIMIT_MAX, windowSeconds: RATE_LIMIT_WINDOW_MS / 1000 },
    },
  };
}

// ===================== Concurrency guard =====================

let inFlightTimelines = 0;

// ===================== Router =====================

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const method = req.method ?? 'GET';
  const origin = req.headers.origin;

  // One derivation, used for BOTH limiting and logging. Previously these were
  // two separate reads of req.socket.remoteAddress, which meant the log field
  // and the rate-limit key could never disagree -- because both were wrong.
  const clientIp = getClientIp(req);
  const logIp = truncateIp(clientIp);
  let routePath = '-';

  const finish = (status: number) => logAccess(method, routePath, status, Date.now() - started, logIp);

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

    // 1b. Absent Origin on a write. Handled explicitly rather than by falling
    // through the check above. Only enforced once an allowlist exists, so a
    // local `npm run serve` with no ALLOWED_ORIGIN still works unchanged.
    if (method === 'POST' && !origin && ALLOWED_ORIGINS.length > 0 && !ALLOW_NO_ORIGIN_POST) {
      sendJson(res, 403, {
        error: 'An Origin header is required for POST requests on this deployment.',
      });
      return finish(403);
    }

    // 2. Preflight.
    if (method === 'OPTIONS') {
      res.writeHead(204, { ...BASE_HEADERS, ...corsHeaders(allowOrigin) });
      res.end();
      return finish(204);
    }

    // 3. Rate limit, keyed on the derived client address.
    const rl = limiter.hit(rateLimitKey(clientIp));
    if (!rl.ok) {
      sendJson(res, 429, { error: 'Rate limit exceeded.' }, allowOrigin, {
        'Retry-After': String(rl.retryAfter),
      });
      return finish(429);
    }

    // 4. Routes — exactly five, all under /v1.
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

      // Admission control sits AFTER validation and body reading, so a rejected
      // request never occupies a slot, and BEFORE getTimeline, which is the only
      // part that costs real CPU and memory.
      if (inFlightTimelines >= MAX_CONCURRENT_TIMELINES) {
        sendJson(res, 503, { error: 'Server busy; retry shortly.' }, allowOrigin, {
          'Retry-After': '2',
        });
        return finish(503);
      }

      inFlightTimelines++;
      let result;
      try { result = getTimeline(db, input); }
      catch (e: any) {
        sendJson(res, 400, { error: `Could not build timeline: ${e?.message ?? e}` }, allowOrigin);
        return finish(400);
      }
      finally { inFlightTimelines--; }

      const wantsMd = url.searchParams.get('format') === 'markdown'
        || (req.headers.accept ?? '').includes('text/markdown');
      if (wantsMd) {
        sendText(res, 200, renderMarkdown(result), 'text/markdown; charset=utf-8', allowOrigin);
        return finish(200);
      }
      sendJson(res, 200, result, allowOrigin);
      return finish(200);
    }

    // POST /v1/feedback — a thumb, coarsened by the client, forwarded to Notion.
    //
    // Two things make this route unlike the others. It has a second, tighter
    // rate limit: a vote is one click, so a visitor who legitimately fills a
    // timeline and votes on a handful of tiles stays well under 10/min, while
    // a script cannot spend somebody's 60/min timeline budget on thumbs. And it
    // answers 204 WITHOUT awaiting the forward -- the browser should never wait
    // on Notion, and a dead worker must not turn into a hung request.
    if (method === 'POST' && path === '/v1/feedback') {
      const fl = feedbackRateLimit(clientIp);
      if (!fl.ok) {
        sendJson(res, 429, { error: 'Too many votes.' }, allowOrigin, {
          'Retry-After': String(fl.retryAfter),
        });
        return finish(429);
      }

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
        feedbackCounters.rejected++;
        sendJson(res, 400, { error: 'Request body is not valid JSON.' }, allowOrigin);
        return finish(400);
      }

      let vote;
      try { vote = validateVote(parsed); }
      catch (e: any) {
        // A 400 here means the CLIENT is wrong, not the visitor, so it is worth
        // surfacing the specific reason rather than swallowing it.
        feedbackCounters.rejected++;
        sendJson(res, 400, { error: e?.message ?? 'Invalid vote.' }, allowOrigin);
        return finish(400);
      }

      feedbackCounters.accepted++;
      void forwardVote(vote); // deliberately not awaited
      sendNoContent(res, allowOrigin);
      return finish(204);
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
  limiter.stop();
  stopFeedbackLimiter();
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  const m = datasetMeta();
  console.log(`${SERVICE} listening on http://localhost:${PORT} (${API_VERSION})`);
  console.log(`  engine   ${ENGINE_VERSION}`);
  console.log(`  build    ${datasetBuild(m).id} - ${Number(m.totalEvents).toLocaleString()} events`);
  console.log(`  routes:  GET /v1/health  GET /v1/meta  GET /v1/search  POST /v1/timeline  POST /v1/feedback`);
  console.log(`  origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'none — set ALLOWED_ORIGIN'}${ALLOW_DEV_ORIGINS ? ' (+ dev localhost, ALLOW_DEV_ORIGINS=true)' : ''}`);
  console.log(`  limits:  ${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW_MS / 1000}s per client · ${MAX_CONCURRENT_TIMELINES} concurrent timelines · trustedProxyHops=${TRUSTED_PROXY_HOPS}`);
  console.log(`  feedback: ${FEEDBACK_CONFIGURED ? 'forwarding to worker' : 'accept-and-drop (CIRCA_FEEDBACK_WEBHOOK_URL / CIRCA_FEEDBACK_SECRET unset)'}`);
});
