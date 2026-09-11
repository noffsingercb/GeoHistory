import type { EngineConfig, Scope } from './core';

// ===================== config allowlist for POST /v1/timeline =====================
// POST /v1/timeline accepts a `config` object from the client. Until now the
// only check was that it WAS an object -- after which it was merged over
// DEFAULT_CONFIG and used to drive SQLite work and in-memory ranking.
//
// That is a remote CPU/memory denial of service with no auth and no tooling.
// significanceFloor: -1 drops the SQL prefilter floor to the bottom and selects
// essentially the whole ~107k-row dataset instead of a thin slice;
// maxPerSegment / maxSegments / scopeQuota set absurdly high remove the caps
// that bound how much of that result set gets materialized, sorted and
// bucketed in JS. NaN and Infinity slip past `typeof v === 'number'` entirely
// and poison the comparisons instead of erroring.
//
// The pattern here is lifted from feedback.ts, which already got this right:
// an explicit allowlist of keys plus per-field bounds, refusing unknown input
// rather than silently ignoring it. Failing loud matters -- a typo in Circa's
// config should surface as a 400 on the first request, not as a timeline that
// is quietly shaped differently than intended.
//
// IMPORTANT: `config` is NOT removed or ignored. Circa depends on it -- the
// sparsity retry sends scopeFloor.local (RELAXED_LOCAL_FLOOR) when a segment
// returns fewer than MIN_MATCHES entries. Clamp, do not delete.

/**
 * Scopes that accept a per-scope significance-floor override, including
 * universal.
 *
 * The DEFAULT floor values are deliberately not restated here. This list
 * answers one question -- which scopes may be overridden -- and the numbers
 * live in DEFAULT_CONFIG.scopeFloor (core.ts), which is also what GET /v1/meta
 * publishes under `defaults`. A previous version of this comment named a
 * universal floor of 0.6 and went stale against the live 0.85; a comment that
 * restates a constant defined in another file will always go stale again.
 */
const FLOOR_SCOPES: Scope[] = ['local', 'regional', 'national', 'global', 'universal'];

/**
 * Scopes that participate in the round-robin scopeQuota fill. 'universal' is
 * deliberately excluded here -- it has its own dedicated universalQuota knob
 * instead, since core.ts never reads cfg.scopeQuota.universal.
 */
const QUOTA_SCOPES: Scope[] = ['local', 'regional', 'national', 'global'];

/** Weight maps are open-keyed by category, so they need their own bounds. */
const MAX_WEIGHT_KEYS = 40;
const MAX_WEIGHT_KEY_CHARS = 60;
const WEIGHT_KEY_PATTERN = /^[a-z0-9_-]+$/i;

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Bounds are set from what Circa actually sends (src/lib/config.ts:
 * MAX_PER_SEGMENT 19, MAX_SEGMENTS 20, RELAXED_LOCAL_FLOOR 0.05) plus modest
 * headroom for tuning, NOT from what the engine could theoretically survive.
 * A client asking for something outside this range is either broken or
 * hostile, and both deserve the same 400.
 *
 * The floors bottom out at 0.01 rather than 0 on purpose: it is the absolute
 * server-side minimum, so no combination of accepted values can reopen the
 * prefilter to the whole table. See ABSOLUTE_MIN_FLOOR in core.ts, which
 * enforces the same number independently in case a future key lands here
 * without one.
 *
 * universalQuota's 0-10 range and personFloor's 0.01-1 range were added in
 * 0.6 alongside the fields they bound in EngineConfig.
 */
export const CONFIG_BOUNDS = {
  significanceFloor: { min: 0.01, max: 1, integer: false },
  scopeFloor: { min: 0.01, max: 1, integer: false },
  maxPerSegment: { min: 1, max: 50, integer: true },
  maxSegments: { min: 1, max: 40, integer: true },
  scopeQuota: { min: 0, max: 25, integer: true },
  personQuota: { min: 0, max: 25, integer: true },
  universalQuota: { min: 0, max: 10, integer: true },
  personFloor: { min: 0.01, max: 1, integer: false },
  categoryWeights: { min: 0, max: 1, integer: false },
  foundingKindWeights: { min: 0, max: 1, integer: false },
} as const;

function num(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`config.${name} must be a finite number.`);
  }
  if (value < min || value > max) {
    fail(`config.${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function int(name: string, value: unknown, min: number, max: number): number {
  const n = num(name, value, min, max);
  if (!Number.isInteger(n)) fail(`config.${name} must be an integer.`);
  return n;
}

function plainObject(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`config.${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** scopeFloor / scopeQuota: keys are closed to an explicit allowlist. */
function scopeMap(
  name: string,
  value: unknown,
  bounds: { min: number; max: number; integer: boolean },
  allowedScopes: Scope[],
): Partial<Record<Scope, number>> {
  const input = plainObject(name, value);
  const out: Partial<Record<Scope, number>> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!allowedScopes.includes(key as Scope)) {
      fail(`config.${name} has unknown scope "${key.slice(0, 20)}". Allowed: ${allowedScopes.join(', ')}.`);
    }
    out[key as Scope] = bounds.integer
      ? int(`${name}.${key}`, raw, bounds.min, bounds.max)
      : num(`${name}.${key}`, raw, bounds.min, bounds.max);
  }
  return out;
}

/**
 * categoryWeights / foundingKindWeights: keys are open by design (the engine
 * looks a category up and falls back to 1), so the bound is on the SIZE and
 * shape of the map rather than on the key names. Without a cap, a 64 KB body
 * of unique keys becomes a large object merged over DEFAULT_CONFIG on every
 * request.
 */
function weightMap(name: string, value: unknown): Record<string, number> {
  const input = plainObject(name, value);
  const keys = Object.keys(input);
  if (keys.length > MAX_WEIGHT_KEYS) {
    fail(`config.${name} must have at most ${MAX_WEIGHT_KEYS} keys.`);
  }
  const out: Record<string, number> = {};
  for (const key of keys) {
    if (key.length > MAX_WEIGHT_KEY_CHARS || !WEIGHT_KEY_PATTERN.test(key)) {
      fail(`config.${name} has an unacceptable key "${key.slice(0, 20)}".`);
    }
    out[key] = num(`${name}.${key}`, input[key], 0, 1);
  }
  return out;
}

const VALIDATORS: Record<string, (value: unknown) => unknown> = {
  significanceFloor: (v) => num('significanceFloor', v, CONFIG_BOUNDS.significanceFloor.min, CONFIG_BOUNDS.significanceFloor.max),
  scopeFloor: (v) => scopeMap('scopeFloor', v, CONFIG_BOUNDS.scopeFloor, FLOOR_SCOPES),
  maxPerSegment: (v) => int('maxPerSegment', v, CONFIG_BOUNDS.maxPerSegment.min, CONFIG_BOUNDS.maxPerSegment.max),
  maxSegments: (v) => int('maxSegments', v, CONFIG_BOUNDS.maxSegments.min, CONFIG_BOUNDS.maxSegments.max),
  scopeQuota: (v) => scopeMap('scopeQuota', v, CONFIG_BOUNDS.scopeQuota, QUOTA_SCOPES),
  personQuota: (v) => int('personQuota', v, CONFIG_BOUNDS.personQuota.min, CONFIG_BOUNDS.personQuota.max),
  universalQuota: (v) => int('universalQuota', v, CONFIG_BOUNDS.universalQuota.min, CONFIG_BOUNDS.universalQuota.max),
  personFloor: (v) => num('personFloor', v, CONFIG_BOUNDS.personFloor.min, CONFIG_BOUNDS.personFloor.max),
  categoryWeights: (v) => weightMap('categoryWeights', v),
  foundingKindWeights: (v) => weightMap('foundingKindWeights', v),
};

/** Every key the wire format allows. Anything else is a 400. */
export const ALLOWED_CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(VALIDATORS));

/**
 * Validate and clamp a client-supplied `config`.
 *
 * Returns undefined when no config was sent, so the engine's own tuned
 * defaults apply untouched -- which is the normal path for Circa's base
 * request.
 */
export function validateConfig(raw: unknown): Partial<EngineConfig> | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('config must be an object.');

  const input = raw as Record<string, unknown>;

  const unknown = Object.keys(input).filter((key) => !ALLOWED_CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    fail(
      `config has unknown key(s): ${unknown.slice(0, 5).join(', ')}. ` +
        `Allowed: ${[...ALLOWED_CONFIG_KEYS].join(', ')}.`,
    );
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    // An explicit undefined is the same as absent -- JSON cannot produce one,
    // but a hand-built object can.
    if (value === undefined) continue;
    out[key] = VALIDATORS[key](value);
  }

  return out as Partial<EngineConfig>;
}
