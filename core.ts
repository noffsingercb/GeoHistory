import type Database from 'better-sqlite3';

// ===================== Public contract types =====================

export type Precision = 'day' | 'month' | 'year' | 'decade' | 'century';

/**
 * Every scope a stored event row can carry. 'universal' was added in 0.6:
 * curated world-scale rows (seed/universal-v0.1.json) that are drawn
 * additively, ahead of and outside the round-robin below -- see the
 * UNIVERSAL DRAW comment inside getTimeline.
 */
export type Scope = 'local' | 'regional' | 'national' | 'global' | 'universal';

/** The four scopes that participate in the round-robin scopeQuota fill. */
export type RoundRobinScope = Exclude<Scope, 'universal'>;

/**
 * Draw tiers for the round-robin fill. Identical to RoundRobinScope plus
 * 'person', which is not a scope a row can carry -- it is derived from
 * category at draw time so births and deaths stop competing with local
 * history. See TIER_ORDER. 'universal' is deliberately NOT a member: it is
 * drawn in its own additive pass, never through this round-robin.
 */
export type Tier = RoundRobinScope | 'person';

/** Every tier the engine can report on TimelineEntry.tier, round-robin or not. */
export type DrawTier = Tier | 'universal';

/**
 * Where in a ranged row's span a given occurrence falls, relative to the life
 * segment it is being shown in. null for point-in-time rows (no date_end) and
 * for ranged rows that fit entirely inside one segment -- neither needs a
 * suffix. See computeRangedOccurrences.
 */
export type Phase = 'begins' | 'ends' | 'ongoing' | null;

export interface PlaceInput {
  name: string;
  lat: number;
  lng: number;
  level?: 'locality' | 'county' | 'admin1' | 'country';
}

export interface SegmentInput {
  label?: string;
  place: PlaceInput;
  start: string;   // "1832" | "1871-10" | "1871-10-08" | "July 12, 1832"
  end?: string;    // omit for a point-in-time life event
}

export interface EngineConfig {
  significanceFloor: number;             // events below this era-normalized importance are dropped
  scopeFloor: Partial<Record<Scope, number>>; // per-tier override of significanceFloor
  maxPerSegment: number;                 // hard cap on round-robin entries contributed per life segment
  maxSegments: number;
  scopeQuota: Record<RoundRobinScope, number>; // per-segment cap PER round-robin scope tier (the flood control)
  personQuota: number;                   // per-segment cap for birth/death rows
  /**
   * How many universal rows may be drawn per segment. Additive: universal
   * entries sit ON TOP of maxPerSegment rather than counting against it, so a
   * segment can return up to maxPerSegment + universalQuota entries. Decided
   * Sept 5 at 2, default below. See the UNIVERSAL DRAW comment on getTimeline.
   */
  universalQuota: number;
  /**
   * Dedicated significance floor for the person tier (birth/death). Split out
   * from significanceFloor (decided Sept 6, default 0.3) because the two knobs
   * were never really the same number: significanceFloor still backfills any
   * scope not named in scopeFloor, but a low-notability birth at 0.15 (Andy
   * Dick) was slipping through at 0-25 km purely because it shared the old
   * blanket default. See floorFor.
   */
  personFloor: number;
  categoryWeights: Record<string, number>; // rank multipliers; unspecified categories default to 1
  foundingKindWeights: Record<string, number>; // rank multipliers for founding rows, by founding_kind
}

export type TimelineConfigInput = Partial<EngineConfig>;

export interface TimelineInput {
  person?: string;
  segments: SegmentInput[];
  config?: TimelineConfigInput;
}

export interface TimelineEntry {
  id: string;
  /** Raw source label, e.g. 'Arizona'. Matches what events_fts indexes. */
  title: string;
  /**
   * Event-phrased title for rendering, e.g. 'Arizona Statehood'. ALWAYS
   * populated -- falls back to `title` when no display title was derived -- so
   * clients can render this field unconditionally and never implement the
   * fallback themselves. See display-titles.ts for which categories get one.
   */
  displayTitle: string;
  blurb: string | null;
  date: string;
  dateStartISO: string;
  dateEndISO: string;
  precision: Precision;
  lat: number;
  lng: number;
  distanceKm: number;
  reachKm: number;
  /** The event's stored scope. Prefer `tier` for rendering -- see below. */
  scope: string | null;
  /**
   * The tier this row was actually DRAWN from -- added in 0.6 so clients no
   * longer have to infer it from category (a birth stores scope='local' but
   * draws from 'person'; a curated world event stores and draws 'universal').
   * This is the field EntryCard.svelte should badge against, not `scope`.
   */
  tier: DrawTier;
  /**
   * begins / ends / ongoing for a ranged row (date_end set) shown at the
   * start or end of its span in this life, or where the span was already
   * running when this life segment began. null for point events and for
   * ranged rows that fit wholly inside one segment. See
   * computeRangedOccurrences for the exact rule.
   */
  phase: Phase;
  significance: number;
  category: string | null;
  sourceUrl: string | null;
  segmentIndex: number;
  score: number;
}

export interface Timeline {
  datasetVersion: string | null;
  person?: string;
  generatedWith: string;
  entries: TimelineEntry[];
  meta: { segmentCount: number; totalMatched: number; returned: number };
}

/**
 * Engine identity stamped onto every Timeline and reported by GET /v1/meta.
 * Bump whenever output changes for identical input -- including tuning defaults,
 * not just code structure.
 */
export const ENGINE_VERSION = 'geohistory-core@0.6.0';

/**
 * The lowest significance the SQL prefilter will ever use, regardless of what a
 * caller asked for.
 *
 * server.ts already allowlists and clamps the incoming config (see
 * validate-config.ts), so a request cannot reach here with a negative floor.
 * This is the second, independent guard: the engine is a public function that
 * timeline.ts and any future caller can invoke directly, and a floor is the one
 * knob where an out-of-range value does not produce a wrong answer -- it
 * produces a full table scan of ~107k rows per segment. Belt and braces is
 * cheap here and the failure mode is not.
 *
 * 0.01 sits well below every default in DEFAULT_CONFIG (the lowest is local at
 * 0.05) and below Circa's relaxed retry floor, so no legitimate request is
 * touched by it.
 */
export const ABSOLUTE_MIN_FLOOR = 0.01;

/**
 * Hard ceiling on rows materialized from SQLite per segment.
 *
 * The prefilter is bounded by the reach bbox and the year window, which for a
 * real life segment returns hundreds of rows. It is not bounded by anything a
 * caller cannot influence: a low floor over a dense place and a wide year span
 * is a large result set, and every row of it becomes a JS object, gets a
 * haversine computed, and gets sorted -- before any quota applies.
 *
 * Taken in significance order rather than arbitrarily, for two reasons. The cut
 * is deterministic, so the same request keeps returning the same timeline; and
 * significance is the axis selection actually cares about, so the rows dropped
 * at the boundary are the ones least able to win a slot. A caller under the cap
 * -- which is all normal traffic, by a wide margin -- sees byte-identical
 * output, since the per-segment matches are re-sorted by score immediately
 * afterwards.
 */
export const MAX_CANDIDATE_ROWS = 5000;

/** Categories drawn from the 'person' tier rather than their nominal scope. */
const PERSON_CATEGORIES = new Set(['birth', 'death']);

/** The four scopes that fill through the round-robin. */
const ROUND_ROBIN_SCOPES: RoundRobinScope[] = ['local', 'regional', 'national', 'global'];

/** Every scope scopeOf() will recognize, including 'universal'. */
const KNOWN_SCOPES: Scope[] = [...ROUND_ROBIN_SCOPES, 'universal'];

// Ambient-history defaults. A person's birth/death is weighted DOWN because a
// celebrity's fame is not the same as that birth being significant local history
// at the time. Per-scope quotas guarantee a blend (local color + world context)
// rather than letting one tier -- births or battles -- monopolize the slots.
// That guarantee is delivered by the round-robin fill in getTimeline; the quota
// numbers alone cannot do it (see the comment on the fill loop).
//
// The category weight was never enough to keep biography secondary on its own,
// because score.ts scopes birth/death as 'local' and the weight only orders rows
// WITHIN a tier. A famous person at significance 0.95 still scored 0.38 against a
// curated local event at 0.30 -- inside the four local slots, which the fill draws
// first precisely because that tier loses every tiebreak on raw score. Biography
// now draws from its own tier instead, and the weights below only rank persons
// against each other.
//
// scopeFloor exists because a single percentile floor assumes one population. It
// is not: dump events enter at a 3-12 sitelink floor (a long tail at 0.03-0.12)
// while humans enter at 30 sitelinks, and curated seed rows carry hand-authored
// notability on a third scale entirely. 0.05 for local admits curated
// neighborhood history that 0.15 was silently cutting; the higher global floor
// tightens the tier that matches everyone on Earth and is the most crowded.
// universal's 0.85 matches the authored-notability floor set on
// seed/universal-v0.1.json rows (curated, not ladder-derived).
export const DEFAULT_CONFIG: EngineConfig = {
  significanceFloor: 0.15,
  scopeFloor: { local: 0.05, regional: 0.15, national: 0.15, global: 0.2, universal: 0.85 },
  maxPerSegment: 12,
  maxSegments: 20,
  scopeQuota: { local: 4, regional: 3, national: 4, global: 5 },
  personQuota: 2,
  universalQuota: 2,
  personFloor: 0.3,
  categoryWeights: { birth: 0.4, death: 0.5, founding: 0.7 },

  // `founding` covers two events that have nothing to do with each other: a town
  // filing incorporation papers, and a territory becoming a state or a colony
  // becoming a country. score.ts already separates their REACH via founding_kind;
  // these weights separate their RANK, which reach cannot do because both land in
  // a tier alongside genuine history.
  //
  // The corpus makes the case: 37,895 settlement rows at avg notability 0.188 vs
  // 2,192 subnational rows at 0.501. And because notability is sitelink-derived --
  // present-day prominence, not contemporary importance -- a settlement founding
  // can top its tier outright: Oklahoma City is settlement/local at significance
  // 1.0, and bare village foundings (Lincolnwood 0.85, Forest View 0.834) were
  // beating the UN Charter for slots in a Chicago timeline.
  //
  // A single flat 0.7 could not serve both ends. It was measured against Pueblo CO
  // 1902-1921 under the OLD significance distribution, and once pass 1 stopped
  // ranking history against biography, non-founding national rows rose and 0.7
  // dropped Oklahoma and New Mexico statehood out of that timeline entirely.
  // 0.9 restores them above the rescored Tulsa Race Massacre without disturbing
  // the tier's ordering otherwise.
  //
  // 'city' is emitted by rescope-foundings.ts as of the P31-driven pass
  // (Q515 / Q1549591 / Q1637706 / Q174844 / Q5119): a big-city founding reads as
  // regional news, not the bare-village weight settlement carries, but it is not
  // a subnational/country-scale event either. 0.6 sits between the two.
  foundingKindWeights: { settlement: 0.35, institution: 0.5, subnational: 0.9, country: 0.9, city: 0.6 },
};

/**
 * Tier draw order for the round-robin fill: most geographically specific first,
 * biography last. When maxPerSegment is smaller than the sum of the quotas, the
 * tiers listed first are the ones guaranteed a slot -- and local/regional are
 * exactly the tiers that lose every tiebreak on raw score, so they are drawn
 * first. 'person' is drawn last for the same reason in reverse: births and
 * deaths win on fame and would otherwise crowd out the history around them.
 * 'universal' is never a member of this list -- see UNIVERSAL DRAW below.
 */
const TIER_ORDER: Tier[] = ['local', 'regional', 'national', 'global', 'person'];

// ===================== Date handling =====================

interface DateRange { loISO: string; hiISO: string; precision: Precision; }

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Parse a partial or human date into an inclusive [lo, hi] day range + precision. */
export function parseDate(raw: string): DateRange {
  const s = raw.trim();

  const isoM = s.match(/^(\d{3,4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (isoM && /^\d/.test(s)) {
    const year = parseInt(isoM[1], 10);
    const month = isoM[2] ? parseInt(isoM[2], 10) : undefined;
    const day = isoM[3] ? parseInt(isoM[3], 10) : undefined;
    if (month && day) return dayRange(year, month, day);
    if (month) return monthRange(year, month);
    return yearRange(year);
  }

  const hM = s.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{3,4})$/);
  if (hM) {
    const month = MONTHS[hM[1].toLowerCase()];
    const day = hM[2] ? parseInt(hM[2], 10) : undefined;
    const year = parseInt(hM[3], 10);
    if (month && day) return dayRange(year, month, day);
    if (month) return monthRange(year, month);
    return yearRange(year);
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return dayRange(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  throw new Error(`Unparseable date: "${raw}"`);
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');
const isoStr = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const yearRange = (y: number): DateRange => ({ loISO: isoStr(y, 1, 1), hiISO: isoStr(y, 12, 31), precision: 'year' });
const monthRange = (y: number, m: number): DateRange => ({ loISO: isoStr(y, m, 1), hiISO: isoStr(y, m, lastDay(y, m)), precision: 'month' });
const dayRange = (y: number, m: number, d: number): DateRange => ({ loISO: isoStr(y, m, d), hiISO: isoStr(y, m, d), precision: 'day' });

/** Inclusive overlap; lexicographic compare is valid for zero-padded ISO day strings. */
const rangesOverlap = (aLo: string, aHi: string, bLo: string, bHi: string) => aLo <= bHi && bLo <= aHi;

function formatDate(dateStartISO: string, precision: Precision): string {
  const m = dateStartISO.match(/^(\d+)-(\d{2})-(\d{2})$/);
  if (!m) return dateStartISO;
  const year = parseInt(m[1], 10), month = parseInt(m[2], 10), day = parseInt(m[3], 10);
  if (precision === 'day') return `${MONTH_NAMES[month]} ${day}, ${year}`;
  if (precision === 'month') return `${MONTH_NAMES[month]} ${year}`;
  return `${year}`;
}

// ===================== Geo =====================

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  const a = s1 * s1 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ===================== Core query (event-radius matching) =====================

interface EventRow {
  id: string; title: string; display_title: string | null; blurb: string | null;
  date_start: string | null; date_end: string | null; date_precision: string | null;
  lat: number | null; lng: number | null;
  reach_km: number | null; significance: number | null; scope: string | null;
  category: string | null; founding_kind: string | null; source_url: string | null;
}

function normalizeEventDate(row: EventRow): DateRange {
  const start = (row.date_start as string).slice(0, 10);
  const s = parseDate(start);
  let precision: Precision = s.precision;
  if (row.date_precision && ['day', 'month', 'year', 'decade', 'century'].includes(row.date_precision)) {
    precision = row.date_precision as Precision;
  }
  const hiISO = row.date_end ? parseDate((row.date_end as string).slice(0, 10)).hiISO : s.hiISO;
  return { loISO: s.loISO, hiISO, precision };
}

/** Normalize a stored scope string to a known tier, defaulting to the conservative one. */
function scopeOf(raw: string | null): Scope {
  const s = (raw ?? 'local') as Scope;
  return KNOWN_SCOPES.includes(s) ? s : 'local';
}

/**
 * Decide which of a ranged row's overlapping segments it is actually drawn
 * in, and what phase label applies there.
 *
 * Confirmed Sept 5: a ranged row (date_end set) is a candidate in every
 * segment it overlaps, but is drawn in at most two -- the segment holding
 * date_start ('begins') and the one holding date_end ('ends'). A row that
 * started before this life's earliest overlapping segment has no segment
 * holding its actual start, so it is shown as 'ongoing' in that earliest
 * segment instead. A row that fits entirely inside one segment needs neither
 * label.
 *
 * @param segmentIndicesAsc every segment index (ascending) where this event
 *   was a raw candidate, i.e. survived the floor/reach/date-overlap filters.
 */
function computeRangedOccurrences(
  segmentIndicesAsc: number[],
  loISO: string,
  hiISO: string,
  segRanges: Array<{ lo: string; hi: string }>,
): Array<{ segmentIndex: number; phase: Phase }> {
  if (segmentIndicesAsc.length === 0) return [];
  const first = segmentIndicesAsc[0];

  const containsStart = (i: number) => segRanges[i].lo <= loISO && loISO <= segRanges[i].hi;
  const containsEnd = (i: number) => segRanges[i].lo <= hiISO && hiISO <= segRanges[i].hi;

  const startSeg = segmentIndicesAsc.find(containsStart);
  const endSeg = segmentIndicesAsc.find(containsEnd);

  // The whole span sits inside one segment -- no suffix needed.
  if (startSeg !== undefined && startSeg === endSeg) {
    return [{ segmentIndex: startSeg, phase: null }];
  }

  const occurrences: Array<{ segmentIndex: number; phase: Phase }> = [];
  if (startSeg !== undefined) {
    occurrences.push({ segmentIndex: startSeg, phase: 'begins' });
  } else {
    // Started before this life's earliest overlapping segment.
    occurrences.push({ segmentIndex: first, phase: 'ongoing' });
  }
  if (endSeg !== undefined && endSeg !== occurrences[0].segmentIndex) {
    occurrences.push({ segmentIndex: endSeg, phase: 'ends' });
  }
  return occurrences;
}

/**
 * Reorder a score-sorted pool so the round-robin cursor draws from the
 * emptiest ~6-year bin of the segment first, falling back to pure score
 * when bins are tied or a bin is exhausted. Deterministic -- no randomness --
 * and never invents a pick: a tier with genuinely nothing in a bin still
 * falls back to the next-best score. See item F, "Temporal spread inside a
 * segment".
 */
function applyTemporalSpread<T extends { dateStartISO: string }>(
  pool: T[],
  segLo: string,
  segHi: string,
): T[] {
  if (pool.length <= 1) return pool;

  const loYear = parseInt(segLo.slice(0, 4), 10);
  const hiYear = parseInt(segHi.slice(0, 4), 10);
  const span = Math.max(1, hiYear - loYear);
  const binYears = Math.max(1, Math.ceil(span / 6));
  const binOf = (e: T) => Math.floor((parseInt(e.dateStartISO.slice(0, 4), 10) - loYear) / binYears);

  const remaining = pool.slice(); // already score-sorted
  const binCounts = new Map<number, number>();
  const ordered: T[] = [];
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestCount = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const count = binCounts.get(binOf(remaining[i])) ?? 0;
      if (count < bestCount) { bestCount = count; bestIndex = i; }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    binCounts.set(binOf(picked), (binCounts.get(binOf(picked)) ?? 0) + 1);
    ordered.push(picked);
  }
  return ordered;
}

export function getTimeline(db: Database.Database, input: TimelineInput): Timeline {
  const cfg: EngineConfig = {
    significanceFloor: input.config?.significanceFloor ?? DEFAULT_CONFIG.significanceFloor,
    scopeFloor: { ...DEFAULT_CONFIG.scopeFloor, ...(input.config?.scopeFloor ?? {}) },
    maxPerSegment: input.config?.maxPerSegment ?? DEFAULT_CONFIG.maxPerSegment,
    maxSegments: input.config?.maxSegments ?? DEFAULT_CONFIG.maxSegments,
    scopeQuota: { ...DEFAULT_CONFIG.scopeQuota, ...(input.config?.scopeQuota ?? {}) },
    personQuota: input.config?.personQuota ?? DEFAULT_CONFIG.personQuota,
    universalQuota: input.config?.universalQuota ?? DEFAULT_CONFIG.universalQuota,
    personFloor: input.config?.personFloor ?? DEFAULT_CONFIG.personFloor,
    categoryWeights: { ...DEFAULT_CONFIG.categoryWeights, ...(input.config?.categoryWeights ?? {}) },
    foundingKindWeights: { ...DEFAULT_CONFIG.foundingKindWeights, ...(input.config?.foundingKindWeights ?? {}) },
  };

  // A caller that sets only significanceFloor means it as a global floor, so drop
  // any default per-scope override that would sit below it. Explicit scopeFloor
  // entries still win -- that is what the knob is for.
  if (input.config?.significanceFloor !== undefined) {
    const explicit = input.config?.scopeFloor ?? {};
    for (const sc of KNOWN_SCOPES) {
      if (explicit[sc] === undefined) cfg.scopeFloor[sc] = Math.max(cfg.scopeFloor[sc] ?? 0, cfg.significanceFloor);
    }
  }

  /** Person rows use their own dedicated floor rather than any scope's. */
  const floorFor = (category: string | null, scope: Scope): number => {
    if (PERSON_CATEGORIES.has(category ?? '')) return cfg.personFloor;
    return cfg.scopeFloor[scope] ?? cfg.significanceFloor;
  };

  /**
   * Rank multiplier. Founding rows resolve through founding_kind first, so a town
   * incorporating and a territory achieving statehood are not ranked as the same
   * kind of event; unclassified foundings fall back to categoryWeights.founding.
   */
  const weightFor = (category: string | null, foundingKind: string | null): number => {
    if (category === 'founding' && foundingKind) {
      const w = cfg.foundingKindWeights[foundingKind];
      if (typeof w === 'number') return w;
    }
    return cfg.categoryWeights[category ?? ''] ?? 1;
  };

  // The SQL prefilter can only apply one number, so it applies the loosest floor in
  // play and keeps using idx_events_significance; the exact per-tier floor is
  // enforced per row below.
  const minFloor = Math.max(
    ABSOLUTE_MIN_FLOOR,
    Math.min(
      cfg.significanceFloor,
      ...Object.values(cfg.scopeFloor).filter((v): v is number => typeof v === 'number'),
    ),
  );

  const segments = input.segments.slice(0, cfg.maxSegments);

  // display_title and founding_kind are later additions, and Step 1.4 bakes
  // events.sqlite into an immutable image layer -- so probe for the columns instead
  // of assuming them, and keep working against a DB built before they existed.
  let columns = new Set<string>();
  try {
    for (const c of db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>) columns.add(c.name);
  } catch { /* fall back to the minimal column set */ }
  const hasDisplayTitle = columns.has('display_title');
  const hasFoundingKind = columns.has('founding_kind');

  // An event matches when the observer's coordinate falls inside the event's own
  // reach box (cheap, portable spatial prefilter) -- exact haversine refines below.
  //
  // Range-overlap prefilter (0.6): a row matches a segment when its span
  // [date_start, date_end] overlaps the segment's [loYear, hiYear], not only
  // when date_start falls inside it. Rows without date_end behave exactly as
  // before -- COALESCE falls back to date_start. This is what lets a
  // multi-year war surface in every segment it touches instead of only the
  // one containing its start year, and is written to match idx_events_end_year.
  //
  // ORDER BY + LIMIT bound how much this can return. Without them the row count
  // is a function of how low the floor is and how dense the place is, and every
  // returned row costs an object, a haversine and a slot in a sort.
  const stmt = db.prepare(`
    SELECT id, title, ${hasDisplayTitle ? 'display_title' : 'NULL AS display_title'},
           blurb, date_start, date_end, date_precision, lat, lng,
           reach_km, significance, scope, category,
           ${hasFoundingKind ? 'founding_kind' : 'NULL AS founding_kind'}, source_url
    FROM events
    WHERE significance >= @floor
      AND reach_km IS NOT NULL
      AND reach_min_lat <= @lat AND reach_max_lat >= @lat
      AND reach_min_lng <= @lng AND reach_max_lng >= @lng
      AND substr(date_start, 1, 4) <= @hiYear
      AND COALESCE(substr(date_end, 1, 4), substr(date_start, 1, 4)) >= @loYear
    ORDER BY significance DESC, id ASC
    LIMIT @limit
  `);

  let datasetVersion: string | null = null;
  try {
    const r = db.prepare(`SELECT value FROM meta WHERE key = 'dataset_version'`).get() as { value?: string } | undefined;
    datasetVersion = r?.value ?? null;
  } catch { /* meta table may not exist on very old DBs */ }

  // ---- Pass 1: per-segment candidates, before any dedupe or quota draw ----
  //
  // Every segment's SQL + row-level filtering runs first and in full. Pass 2
  // needs this: deciding where a ranged row is allowed to be drawn requires
  // knowing every segment it overlaps, not just the one currently in hand.
  type Draft = TimelineEntry & { hasDateEnd: boolean };

  const segRanges: Array<{ lo: string; hi: string }> = [];
  const segmentCandidates: Draft[][] = [];
  let totalMatched = 0;

  segments.forEach((seg, segmentIndex) => {
    const segLo = parseDate(seg.start).loISO;
    const segHi = (seg.end ? parseDate(seg.end) : parseDate(seg.start)).hiISO;
    segRanges.push({ lo: segLo, hi: segHi });

    const rows = stmt.all({
      floor: minFloor,
      lat: seg.place.lat,
      lng: seg.place.lng,
      loYear: segLo.slice(0, 4),
      hiYear: segHi.slice(0, 4),
      limit: MAX_CANDIDATE_ROWS,
    }) as EventRow[];

    const drafts: Draft[] = [];
    for (const row of rows) {
      if (row.lat == null || row.lng == null || !row.date_start || row.reach_km == null) continue;

      const significance = typeof row.significance === 'number' ? row.significance : 0;
      const scope = scopeOf(row.scope);
      if (significance < floorFor(row.category, scope)) continue; // exact per-tier floor

      const ev = normalizeEventDate(row);
      if (!rangesOverlap(ev.loISO, ev.hiISO, segLo, segHi)) continue;

      const isUniversal = scope === 'universal';
      const distanceKm = haversineKm(seg.place.lat, seg.place.lng, row.lat, row.lng);
      let headroom: number;
      if (isUniversal) {
        // UNIVERSAL DRAW: no distance test. A universal row's reach_km already
        // covers the globe (20038 km, set by score.ts), but this makes that
        // explicit rather than relying on the reach circle happening to be
        // big enough, and it is what lets headroom read as "fully earned"
        // rather than "happened to be close".
        headroom = 1;
      } else {
        if (distanceKm > row.reach_km) continue; // exact reach-circle test
        headroom = 1 - Math.min(1, distanceKm / row.reach_km);
      }

      const weight = weightFor(row.category, row.founding_kind); // demote biography and bare foundings vs substantive history
      const score = Math.round(significance * weight * (0.6 + 0.4 * headroom) * 1000) / 1000;

      totalMatched++;
      const tier: DrawTier = isUniversal ? 'universal' : (PERSON_CATEGORIES.has(row.category ?? '') ? 'person' : scope);
      drafts.push({
        id: row.id, title: row.title,
        displayTitle: row.display_title?.trim() || row.title,
        blurb: row.blurb,
        date: formatDate(ev.loISO, ev.precision),
        dateStartISO: ev.loISO, dateEndISO: ev.hiISO, precision: ev.precision,
        lat: row.lat, lng: row.lng,
        distanceKm: Math.round(distanceKm * 10) / 10,
        reachKm: row.reach_km,
        scope: row.scope, tier, phase: null,
        significance, category: row.category, sourceUrl: row.source_url,
        segmentIndex, score,
        hasDateEnd: Boolean(row.date_end),
      });
    }
    segmentCandidates.push(drafts);
  });

  // ---- Pass 2: bookend ranged rows to at most two occurrences per life ----
  //
  // A ranged row (date_end set) is a candidate in every segment it overlaps
  // (pass 1 above already computed that), but it is only ever DRAWN in the
  // segment holding date_start and the one holding date_end -- see
  // computeRangedOccurrences. Point rows (no date_end) are untouched here and
  // keep the old "first segment to win a quota slot" dedupe in pass 3.
  const occurrencesById = new Map<string, Array<{ segmentIndex: number; phase: Phase }>>();
  {
    const segmentsByEventId = new Map<string, Draft[]>();
    for (const drafts of segmentCandidates) {
      for (const d of drafts) {
        if (!d.hasDateEnd) continue;
        const list = segmentsByEventId.get(d.id);
        if (list) list.push(d); else segmentsByEventId.set(d.id, [d]);
      }
    }
    for (const [id, drafts] of segmentsByEventId) {
      const indices = drafts.map((d) => d.segmentIndex).sort((a, b) => a - b);
      const { dateStartISO, dateEndISO } = drafts[0];
      occurrencesById.set(id, computeRangedOccurrences(indices, dateStartISO, dateEndISO, segRanges));
    }
  }

  // ---- Pass 3: per segment, apply the occurrence plan, then draw ----
  const drawCount = new Map<string, number>();
  const entries: TimelineEntry[] = [];

  segmentCandidates.forEach((drafts, segmentIndex) => {
    const segRange = segRanges[segmentIndex];

    const matches: Draft[] = [];
    for (const d of drafts) {
      if (d.hasDateEnd) {
        const occurrences = occurrencesById.get(d.id) ?? [];
        const occurrence = occurrences.find((o) => o.segmentIndex === segmentIndex);
        if (!occurrence) continue; // this segment lost the bookend assignment
        matches.push({ ...d, phase: occurrence.phase });
      } else {
        matches.push(d);
      }
    }

    matches.sort((a, b) =>
      b.score !== a.score ? b.score - a.score :
      a.dateStartISO !== b.dateStartISO ? (a.dateStartISO < b.dateStartISO ? -1 : 1) :
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    // Bucket the matches by draw tier, preserving the score order established
    // above. Births and deaths are pulled into their own tier so biography
    // cannot consume the slots reserved for the history around it; universal
    // rows are pulled into their own pool too, drawn additively below rather
    // than through the round-robin.
    const pools: Record<DrawTier, Draft[]> = { local: [], regional: [], national: [], global: [], person: [], universal: [] };
    for (const m of matches) {
      const already = drawCount.get(m.id) ?? 0;
      // A point row (maxOccurrences 1) that already won a slot in an earlier
      // segment is not offered again. A ranged row's occurrence plan already
      // restricts it to its assigned segment(s) via the `continue` above, so
      // this is belt-and-braces rather than the primary guard for those.
      const maxOccurrences = m.hasDateEnd ? (occurrencesById.get(m.id)?.length ?? 1) : 1;
      if (already >= maxOccurrences) continue;
      pools[m.tier].push(m);
    }

    // Temporal spread (item F): within each round-robin tier's pool, prefer
    // the best-scoring candidate from whichever ~6-year bin of the segment has
    // the fewest picks so far, rather than draining the pool in pure score
    // order -- see applyTemporalSpread.
    for (const tier of TIER_ORDER) {
      pools[tier] = applyTemporalSpread(pools[tier], segRange.lo, segRange.hi);
    }

    // Draw ROUND-ROBIN across tiers rather than greedily by score, so the quotas
    // are guarantees and not merely caps.
    //
    // The greedy version took the top maxPerSegment matches overall and let the
    // quotas cut the overflow. Since the quotas sum to 18 and a caller typically
    // asks for 10, the tiers that score highest -- global and national, which win
    // on fame -- consumed every slot, and the local/regional tiers this product
    // exists to surface were truncated first. Round-robin reserves each tier its
    // share up front and lets score decide only WITHIN a tier.
    const cursor: Record<Tier, number> = { local: 0, regional: 0, national: 0, global: 0, person: 0 };
    const kept: Draft[] = [];
    let drewOne = true;
    while (kept.length < cfg.maxPerSegment && drewOne) {
      drewOne = false;
      for (const sc of TIER_ORDER) {
        if (kept.length >= cfg.maxPerSegment) break;
        const quota = sc === 'person' ? cfg.personQuota : (cfg.scopeQuota[sc] ?? cfg.maxPerSegment);
        const next = cursor[sc];
        if (next >= quota || next >= pools[sc].length) continue; // tier capped or exhausted
        kept.push(pools[sc][next]);
        cursor[sc] = next + 1;
        drewOne = true;
      }
    }

    // UNIVERSAL DRAW: additive, on top of maxPerSegment, capped by
    // universalQuota. Deliberately outside the round-robin above -- see
    // EngineConfig.universalQuota and the DEFAULT_CONFIG comment. pools.universal
    // is already score-sorted (matches was sorted before bucketing), so this is
    // simply the top `universalQuota` of it.
    const universalKept = pools.universal.slice(0, cfg.universalQuota);
    for (const m of universalKept) kept.push(m);

    for (const m of kept) {
      drawCount.set(m.id, (drawCount.get(m.id) ?? 0) + 1);
      const { hasDateEnd, ...entry } = m;
      entries.push(entry);
    }
  });

  entries.sort((a, b) =>
    a.dateStartISO < b.dateStartISO ? -1 :
    a.dateStartISO > b.dateStartISO ? 1 :
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return {
    datasetVersion,
    person: input.person,
    generatedWith: ENGINE_VERSION,
    entries,
    meta: { segmentCount: segments.length, totalMatched, returned: entries.length },
  };
}

// ===================== Renderer =====================

export function renderMarkdown(t: Timeline): string {
  const out: string[] = [`# Timeline${t.person ? ` \u2014 ${t.person}` : ''}`, ''];
  for (const e of t.entries) {
    const phaseSuffix = e.phase ? ` (${e.phase})` : '';
    out.push(`- **${e.date}** \u2014 ${e.displayTitle}${phaseSuffix}`);
    if (e.blurb) out.push(`  ${e.blurb}`);
    out.push(`  _${e.tier} \u00b7 sig ${e.significance} \u00b7 ${e.distanceKm}/${e.reachKm} km${e.sourceUrl ? ` \u00b7 [source](${e.sourceUrl})` : ''}_`);
  }
  out.push('', `_Dataset ${t.datasetVersion ?? 'unknown'} \u00b7 ${t.meta.returned} of ${t.meta.totalMatched} matched events_`);
  return out.join('\n');
}
