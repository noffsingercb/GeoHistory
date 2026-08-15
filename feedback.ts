import crypto from 'node:crypto';

// ===================== Feedback capture (write-free) =====================
// Backing module for POST /v1/feedback.
//
// This service is read-only and stays that way. Nothing here touches
// events.sqlite, writes a file, or holds state beyond an in-memory rate-limit
// counter. A vote is validated, signed, and handed to a Notion Worker webhook
// which owns the storage.
//
// Environment:
//   CIRCA_FEEDBACK_WEBHOOK_URL   Notion Worker webhook. Unset => accept + drop.
//   CIRCA_FEEDBACK_SECRET        HMAC-SHA256 signing key. Unset => accept + drop.
//   FEEDBACK_RATE_LIMIT_MAX      votes per IP per window (default 10)
//   FEEDBACK_RATE_LIMIT_WINDOW   window in seconds (default 60)
//   FEEDBACK_FORWARD_TIMEOUT     ms to wait on the worker (default 5000)

const WEBHOOK_URL = process.env.CIRCA_FEEDBACK_WEBHOOK_URL ?? '';
const SECRET = process.env.CIRCA_FEEDBACK_SECRET ?? '';

const RATE_LIMIT_MAX = parseInt(process.env.FEEDBACK_RATE_LIMIT_MAX ?? '10', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.FEEDBACK_RATE_LIMIT_WINDOW ?? '60', 10) * 1000;
const FORWARD_TIMEOUT_MS = parseInt(process.env.FEEDBACK_FORWARD_TIMEOUT ?? '5000', 10);

/** True once both the destination and the signing key are present. */
export const FEEDBACK_CONFIGURED = Boolean(WEBHOOK_URL && SECRET);

// ===================== The accepted shape =====================

const VERDICTS = ['up', 'down'] as const;
const SCOPES = ['local', 'regional', 'national', 'global'] as const;

// Nine buckets, not six. The national tier's observed range is roughly
// 1050-2400 km, so a single 500+ bucket would have swallowed the majority of
// votes and told us nothing about the one number this feature exists to test.
// The boundaries straddle the 1500 km national scopeBase deliberately.
const DISTANCE_BUCKETS = [
  '0-25', '25-50', '50-100', '100-250', '250-500',
  '500-1000', '1000-1500', '1500-2500', '2500+',
] as const;

export type Vote = {
  voteId: string;
  eventId: string;
  eventTitle: string;
  verdict: (typeof VERDICTS)[number];
  scope: (typeof SCOPES)[number];
  significance: number;
  reachKm: number;
  headroom: number;
  relaxed: boolean;
  distanceBucket: (typeof DISTANCE_BUCKETS)[number];
  segmentDecade: string;
  datasetVersion: string;
  buildId: string;
};

// Every key the wire format allows. Anything else is a 400.
//
// This list is the enforcement point for the privacy posture. The stored row
// must never carry a place name, a coordinate, an exact distance, an IP, or a
// session id -- so rather than stripping unknown fields silently, we refuse the
// request. A careless client change then fails in the open instead of quietly
// shipping a home town into a durable Notion database.
//
// eventTitle is the one string here describing the world rather than the
// visitor. It is public dataset data, already rendered on the tile the vote
// came from, and it exists so the Notion rows are readable as something other
// than a column of opaque ids.
const ALLOWED_KEYS = new Set<string>([
  'voteId', 'eventId', 'eventTitle', 'verdict', 'scope', 'significance', 'reachKm',
  'headroom', 'relaxed', 'distanceBucket', 'segmentDecade',
  'datasetVersion', 'buildId',
]);

const MAX_ID_CHARS = 200;
const MAX_TITLE_CHARS = 500;
const DECADE_PATTERN = /^\d{3,4}0s$/;

function requireString(v: unknown, name: string, max = MAX_ID_CHARS): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} must be a non-empty string.`);
  if (v.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return v;
}

function requireUnit(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number.`);
  if (v < 0 || v > 1) throw new Error(`${name} must be between 0 and 1.`);
  return v;
}

/**
 * Validates a vote strictly and returns it normalized. Throws with a specific
 * message on anything unexpected; the caller turns that into a 400.
 */
export function validateVote(body: unknown): Vote {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  const unknown = Object.keys(b).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`Unexpected field(s): ${unknown.slice(0, 5).join(', ')}.`);
  }

  const verdict = b.verdict;
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as Vote['verdict'])) {
    throw new Error(`verdict must be one of: ${VERDICTS.join(', ')}.`);
  }

  const scope = b.scope;
  if (typeof scope !== 'string' || !SCOPES.includes(scope as Vote['scope'])) {
    throw new Error(`scope must be one of: ${SCOPES.join(', ')}.`);
  }

  const bucket = b.distanceBucket;
  if (typeof bucket !== 'string' || !DISTANCE_BUCKETS.includes(bucket as Vote['distanceBucket'])) {
    throw new Error(`distanceBucket must be one of: ${DISTANCE_BUCKETS.join(', ')}.`);
  }

  const decade = requireString(b.segmentDecade, 'segmentDecade', 8);
  if (!DECADE_PATTERN.test(decade)) {
    throw new Error('segmentDecade must look like "1920s" -- an exact year is never accepted.');
  }

  if (typeof b.relaxed !== 'boolean') throw new Error('relaxed must be a boolean.');

  const reachKm = b.reachKm;
  if (typeof reachKm !== 'number' || !Number.isFinite(reachKm) || reachKm < 0 || reachKm > 50000) {
    throw new Error('reachKm must be a finite number between 0 and 50000.');
  }

  return {
    voteId: requireString(b.voteId, 'voteId'),
    eventId: requireString(b.eventId, 'eventId'),
    eventTitle: requireString(b.eventTitle, 'eventTitle', MAX_TITLE_CHARS),
    verdict: verdict as Vote['verdict'],
    scope: scope as Vote['scope'],
    significance: requireUnit(b.significance, 'significance'),
    reachKm,
    headroom: requireUnit(b.headroom, 'headroom'),
    relaxed: b.relaxed,
    distanceBucket: bucket as Vote['distanceBucket'],
    segmentDecade: decade,
    datasetVersion: requireString(b.datasetVersion, 'datasetVersion'),
    buildId: requireString(b.buildId, 'buildId'),
  };
}

// ===================== Rate limit (its own bucket) =====================

// Separate from the general limiter on purpose. Votes are cheap to issue and
// cheap to spam, and vote spam must not be able to exhaust somebody's timeline
// budget for the window.

const voteBuckets = new Map<string, { count: number; resetAt: number }>();

export function feedbackRateLimit(key: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  let b = voteBuckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    voteBuckets.set(key, b);
  }
  b.count++;
  return {
    ok: b.count <= RATE_LIMIT_MAX,
    retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}

export const feedbackSweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of voteBuckets) if (b.resetAt <= now) voteBuckets.delete(k);
}, RATE_LIMIT_WINDOW_MS).unref();

// ===================== Counters (no bodies, ever) =====================

export const feedbackCounters = { accepted: 0, sent: 0, dropped: 0, failed: 0, rejected: 0 };

// ===================== Signing and forwarding =====================

/** Hex HMAC-SHA256 over the exact bytes sent, prefixed so the scheme is legible. */
export function signBody(raw: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex')}`;
}

export type ForwardOutcome = 'sent' | 'dropped' | 'failed';

/**
 * Forwards a validated vote to the worker. Never throws.
 *
 * The signature is computed over the raw body string that is actually sent, not
 * over a re-serialization of the parsed object, because the worker verifies
 * against its own raw body. Re-stringifying on either side would eventually
 * disagree on key order and fail verification for no visible reason.
 *
 * Returns 'dropped' when the endpoint is not configured yet -- an expected
 * state, not an error, until the worker is deployed.
 */
export async function forwardVote(vote: Vote): Promise<ForwardOutcome> {
  if (!FEEDBACK_CONFIGURED) {
    feedbackCounters.dropped++;
    return 'dropped';
  }
  const raw = JSON.stringify(vote);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-circa-signature': signBody(raw),
      },
      body: raw,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    // Notion answers 202 and runs the handler later, so a 2xx here means
    // "accepted for delivery" and nothing about whether the row was written.
    if (!res.ok) {
      feedbackCounters.failed++;
      return 'failed';
    }
    feedbackCounters.sent++;
    return 'sent';
  } catch {
    // Timeout, DNS, TLS, worker down. The browser is never told; a lost thumb
    // is not worth a 500, and the tile has already filled optimistically.
    feedbackCounters.failed++;
    return 'failed';
  }
}
