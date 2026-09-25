// ===================== Nearby events (v1) =====================
// "Which recorded events happened closest to THIS point?"
//
// This is not the timeline question and cannot be answered by the timeline
// engine. core.ts asks whether the caller's coordinate falls inside an event's
// relevance circle -- a containment test against the materialized reach box,
// served by idx_events_reach_box. A national election reaches a whole country,
// so it is "relevant" from 600 km away and would dominate a proximity list
// while being, in the plain sense of the word, nowhere near you.
//
// Nearby asks the inverse: order rows by the distance from the caller to the
// EVENT'S OWN POINT. That is a different predicate over different columns
// (events.lat / events.lng, idx_events_lat_lng) and it deliberately ignores
// reach_km entirely.
//
// WHAT THIS MODULE IS NOT
// It holds no product policy. It does not know about radius ladders, does not
// widen a search that came back thin, does not decide that biographies are
// boring, and does not write empty-state copy. A client asks one question at
// one radius and gets a truthful answer or an empty list; deciding what to do
// with an empty list is the client's job. Keeping that line means a second
// consumer with different taste does not have to undo this one's opinions.
//
// PRIVACY
// The caller's coordinate is an input, never an output. Nothing here logs it,
// caches it, echoes it in an error message, or stores it. The route that wraps
// this function accepts it in a POST body for the same reason -- see
// docs/nearby.md.

export const NEARBY_VERSION = 'geohistory-nearby@0.1.0';

/**
 * Minimal structural view of the database handle.
 *
 * Typed structurally rather than importing better-sqlite3's Database type so
 * this module stays as portable as core.ts: anything that can prepare a
 * statement can drive it, including a test double.
 */
export interface NearbyDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

/**
 * Which coordinate claim placed a row.
 *
 * 'direct' admits only rows whose point is the event's own: P625 (coordinate
 * location), P276 (stated location) and NULL (a curated seed row, hand-placed).
 * It excludes P17 and P495, which are COUNTRY centroids, and P19 / P20, which
 * are a person's birth and death place -- fine for a timeline, actively
 * misleading for "what happened near here", because a country centroid puts
 * every coordinate-less treaty in the geographic middle of its country and
 * would make that arbitrary spot the most historic place in the nation.
 *
 * 'all' disables the filter. It exists so a caller can measure the difference
 * rather than take this module's word for it.
 */
export type CoordinateMode = 'direct' | 'all';

const DIRECT_COORD_SOURCES = ['P625', 'P276'] as const;

export const NEARBY_BOUNDS = {
  radiusKm: { min: 0.1, max: 150 },
  limit: { min: 5, max: 25, default: 12 },
  significanceFloor: { min: 0.01, max: 1, default: 0.05 },
  maxDateSpanYears: 1000,
  maxCandidateRows: 10000,
  maxExcludedCategories: 20,
  defaultCoordinateMode: 'direct' as CoordinateMode,
} as const;

export interface NearbyInput {
  lat: number;
  lng: number;
  radiusKm: number;
  limit: number;
  significanceFloor: number;
  coordinateMode: CoordinateMode;
  /** Category names to drop. Generic: this module has no opinion about which. */
  excludeCategories: string[];
  /** Distance-blind rows are excluded by default; they are not "near" anything. */
  includeUniversal: boolean;
  fromYear?: number;
  toYear?: number;
}

export interface NearbyEntry {
  id: string;
  title: string;
  displayTitle: string | null;
  blurb: string | null;
  dateStart: string;
  dateEnd: string | null;
  datePrecision: string | null;
  category: string | null;
  scope: string | null;
  significance: number | null;
  notability: number | null;
  coordSource: string | null;
  lat: number;
  lng: number;
  /** Great-circle distance from the queried point, rounded to 10 m. */
  distanceKm: number;
  sourceUrl: string | null;
}

export interface NearbyResult {
  datasetVersion: string | null;
  engine: string;
  radiusKm: number;
  coordinateMode: CoordinateMode;
  significanceFloor: number;
  /** Rows inside the radius that passed every filter, before the limit cut. */
  totalWithinRadius: number;
  returned: number;
  entries: NearbyEntry[];
}

export class NearbyOverflowError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'NearbyOverflowError';
  }
}

// ===================== Geometry =====================

const EARTH_RADIUS_KM = 6371; // identical to core.ts's haversineKm; see docs/nearby.md
const KM_PER_DEGREE_LAT = 111.32;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in km. Same formula and radius as the timeline engine. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  /** One range normally; two when the box crosses the antimeridian. */
  lngRanges: Array<[number, number]>;
}

/**
 * Indexable prefilter around a point.
 *
 * The box is a superset of the circle -- corners are further away than the
 * radius -- so an exact haversine test still runs on every candidate. The box
 * exists only so SQLite can use idx_events_lat_lng instead of reading 116k rows.
 *
 * Two cases break naive arithmetic and both are handled here rather than being
 * discovered as a wrong answer:
 *
 *   Antimeridian. At 179.9E a 150 km box runs past +180. `lng BETWEEN 178.5 AND
 *   181.4` matches nothing, so the query silently returns an empty list for a
 *   legitimate location. The range is split in two and OR-ed.
 *
 *   Poles. Longitude degrees collapse toward the pole, so the longitude delta
 *   goes to infinity and the box is meaningless. Past the point where the box
 *   would contain a pole, the longitude filter is dropped entirely and the
 *   latitude band plus the exact distance test does the work.
 */
export function boundingBox(lat: number, lng: number, radiusKm: number): BoundingBox {
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;
  const minLat = lat - latDelta;
  const maxLat = lat + latDelta;

  if (minLat <= -90 || maxLat >= 90) {
    return {
      minLat: Math.max(-90, minLat),
      maxLat: Math.min(90, maxLat),
      lngRanges: [[-180, 180]],
    };
  }

  // cos() of the latitude nearest a pole gives the widest longitude span the
  // circle needs at any latitude inside the band.
  const widestLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const cos = Math.cos(toRadians(widestLat));
  if (cos <= 1e-9) {
    return { minLat, maxLat, lngRanges: [[-180, 180]] };
  }

  const lngDelta = latDelta / cos;
  if (lngDelta >= 180) {
    return { minLat, maxLat, lngRanges: [[-180, 180]] };
  }

  const minLng = lng - lngDelta;
  const maxLng = lng + lngDelta;
  if (minLng < -180) {
    return { minLat, maxLat, lngRanges: [[-180, maxLng], [minLng + 360, 180]] };
  }
  if (maxLng > 180) {
    return { minLat, maxLat, lngRanges: [[minLng, 180], [-180, maxLng - 360]] };
  }
  return { minLat, maxLat, lngRanges: [[minLng, maxLng]] };
}

// ===================== Query =====================

interface CandidateRow {
  id: string;
  title: string;
  display_title: string | null;
  blurb: string | null;
  date_start: string;
  date_end: string | null;
  date_precision: string | null;
  category: string | null;
  scope: string | null;
  significance: number | null;
  notability: number | null;
  coord_source: string | null;
  lat: number;
  lng: number;
  source_url: string | null;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/** Year a row starts, from the ISO prefix. Cheap, and indexable as written. */
function startYear(row: CandidateRow): number {
  return parseInt(row.date_start.slice(0, 4), 10);
}

function buildCandidateSql(input: NearbyInput, box: BoundingBox): {
  sql: string;
  params: Array<string | number>;
} {
  const params: Array<string | number> = [];
  const where: string[] = [];

  where.push('e.lat IS NOT NULL AND e.lng IS NOT NULL');

  where.push('e.lat BETWEEN ? AND ?');
  params.push(box.minLat, box.maxLat);

  const lngClause = box.lngRanges.map(() => '(e.lng BETWEEN ? AND ?)').join(' OR ');
  where.push(`(${lngClause})`);
  for (const [lo, hi] of box.lngRanges) params.push(lo, hi);

  // A row with no significance has never been scored; it cannot clear a floor.
  where.push('e.significance IS NOT NULL AND e.significance >= ?');
  params.push(input.significanceFloor);

  if (!input.includeUniversal) {
    where.push("(e.scope IS NULL OR e.scope <> 'universal')");
  }

  if (input.coordinateMode === 'direct') {
    where.push(
      `(e.coord_source IS NULL OR e.coord_source IN (${placeholders(DIRECT_COORD_SOURCES.length)}))`,
    );
    params.push(...DIRECT_COORD_SOURCES);
  }

  if (input.excludeCategories.length > 0) {
    where.push(
      `(e.category IS NULL OR e.category NOT IN (${placeholders(input.excludeCategories.length)}))`,
    );
    params.push(...input.excludeCategories);
  }

  if (input.fromYear !== undefined) {
    where.push('CAST(substr(e.date_start, 1, 4) AS INTEGER) >= ?');
    params.push(input.fromYear);
  }
  if (input.toYear !== undefined) {
    where.push('CAST(substr(e.date_start, 1, 4) AS INTEGER) <= ?');
    params.push(input.toYear);
  }

  // LIMIT is maxCandidateRows + 1 on purpose: reading one row past the ceiling
  // is how overflow is DETECTED. Selecting exactly the ceiling would return a
  // full page that is indistinguishable from a complete result, and the caller
  // would be handed a silently truncated "nearest" list -- the one failure mode
  // that is both invisible and wrong.
  const sql = `
    SELECT e.id, e.title, e.display_title, e.blurb, e.date_start, e.date_end,
           e.date_precision, e.category, e.scope, e.significance, e.notability,
           e.coord_source, e.lat, e.lng, e.source_url
    FROM events e
    WHERE ${where.join('\n      AND ')}
    LIMIT ?
  `;
  params.push(NEARBY_BOUNDS.maxCandidateRows + 1);

  return { sql, params };
}

function datasetVersion(db: NearbyDatabase): string | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'dataset_version'").get() as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null; // meta table may be absent on an old file
  }
}

/**
 * Events near a point, nearest first.
 *
 * Selection is by DISTANCE; presentation is by DATE. Those are separated on
 * purpose: picking the N nearest and then ordering that set chronologically
 * gives a readable local history, whereas ordering the whole candidate set by
 * date and then cutting would return the N oldest rows in the box, which is a
 * different question nobody asked.
 *
 * Ties are broken deterministically (distance, then start date, then id) so the
 * same database and the same request always produce the same list. Two rows at
 * an identical coordinate -- common, because many rows share a city centre --
 * must not reorder between calls.
 */
export function nearbyEvents(db: NearbyDatabase, input: NearbyInput): NearbyResult {
  const box = boundingBox(input.lat, input.lng, input.radiusKm);
  const { sql, params } = buildCandidateSql(input, box);
  const rows = db.prepare(sql).all(...params) as CandidateRow[];

  if (rows.length > NEARBY_BOUNDS.maxCandidateRows) {
    // Fail loudly rather than return a plausible-looking prefix. The message
    // names the bound and the remedy, never the coordinate.
    throw new NearbyOverflowError(
      `Candidate set exceeds ${NEARBY_BOUNDS.maxCandidateRows} rows; narrow the radius or date window.`,
    );
  }

  const withDistance = rows
    .map((row) => ({ row, distanceKm: haversineKm(input.lat, input.lng, row.lat, row.lng) }))
    .filter((c) => c.distanceKm <= input.radiusKm);

  withDistance.sort((a, b) => {
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    if (a.row.date_start !== b.row.date_start) return a.row.date_start < b.row.date_start ? -1 : 1;
    return a.row.id < b.row.id ? -1 : 1;
  });

  const selected = withDistance.slice(0, input.limit);

  selected.sort((a, b) => {
    if (a.row.date_start !== b.row.date_start) return a.row.date_start < b.row.date_start ? -1 : 1;
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    return a.row.id < b.row.id ? -1 : 1;
  });

  return {
    datasetVersion: datasetVersion(db),
    engine: NEARBY_VERSION,
    radiusKm: input.radiusKm,
    coordinateMode: input.coordinateMode,
    significanceFloor: input.significanceFloor,
    totalWithinRadius: withDistance.length,
    returned: selected.length,
    entries: selected.map(({ row, distanceKm }) => ({
      id: row.id,
      title: row.title,
      displayTitle: row.display_title,
      blurb: row.blurb,
      dateStart: row.date_start,
      dateEnd: row.date_end,
      datePrecision: row.date_precision,
      category: row.category,
      scope: row.scope,
      significance: row.significance,
      notability: row.notability,
      coordSource: row.coord_source,
      lat: row.lat,
      lng: row.lng,
      distanceKm: Math.round(distanceKm * 100) / 100,
      sourceUrl: row.source_url,
    })),
  };
}

// ===================== Request validation =====================

const ACCEPTED_FIELDS = new Set([
  'lat',
  'lng',
  'radiusKm',
  'limit',
  'significanceFloor',
  'coordinateMode',
  'excludeCategories',
  'includeUniversal',
  'fromYear',
  'toYear',
]);

const MIN_YEAR = 1;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validates and normalizes a request body.
 *
 * Unknown fields are rejected rather than ignored, for the same reason the
 * timeline's config object is allowlisted: a caller that misspells `radiusKm`
 * should be told, not quietly served a default radius and left to conclude the
 * dataset is thin.
 *
 * Errors never include the coordinate.
 */
export function validateNearbyInput(body: unknown): NearbyInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  const unknown = Object.keys(b).filter((k) => !ACCEPTED_FIELDS.has(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown nearby field(s): ${unknown.slice(0, 5).join(', ')}.`);
  }

  if (!finiteNumber(b.lat) || !finiteNumber(b.lng)) {
    throw new Error('lat and lng must be finite numbers.');
  }
  if (b.lat < -90 || b.lat > 90 || b.lng < -180 || b.lng > 180) {
    throw new Error('lat must be within -90..90 and lng within -180..180.');
  }

  if (!finiteNumber(b.radiusKm)) {
    throw new Error('radiusKm is required and must be a finite number.');
  }
  if (b.radiusKm < NEARBY_BOUNDS.radiusKm.min || b.radiusKm > NEARBY_BOUNDS.radiusKm.max) {
    throw new Error(
      `radiusKm must be between ${NEARBY_BOUNDS.radiusKm.min} and ${NEARBY_BOUNDS.radiusKm.max}.`,
    );
  }

  // Annotated `number`, not inferred: NEARBY_BOUNDS is `as const`, so the
  // default's type is the literal 12 and assigning a caller's value below
  // would not typecheck. The bounds check above is what constrains it.
  let limit: number = NEARBY_BOUNDS.limit.default;
  if (b.limit != null) {
    if (!finiteNumber(b.limit) || !Number.isInteger(b.limit)) {
      throw new Error('limit must be an integer.');
    }
    if (b.limit < NEARBY_BOUNDS.limit.min || b.limit > NEARBY_BOUNDS.limit.max) {
      throw new Error(
        `limit must be between ${NEARBY_BOUNDS.limit.min} and ${NEARBY_BOUNDS.limit.max}.`,
      );
    }
    limit = b.limit;
  }

  // Annotated for the same reason as `limit` above.
  let significanceFloor: number = NEARBY_BOUNDS.significanceFloor.default;
  if (b.significanceFloor != null) {
    if (!finiteNumber(b.significanceFloor)) {
      throw new Error('significanceFloor must be a number.');
    }
    if (
      b.significanceFloor < NEARBY_BOUNDS.significanceFloor.min ||
      b.significanceFloor > NEARBY_BOUNDS.significanceFloor.max
    ) {
      throw new Error(
        `significanceFloor must be between ${NEARBY_BOUNDS.significanceFloor.min} and ${NEARBY_BOUNDS.significanceFloor.max}.`,
      );
    }
    significanceFloor = b.significanceFloor;
  }

  let coordinateMode: CoordinateMode = NEARBY_BOUNDS.defaultCoordinateMode;
  if (b.coordinateMode != null) {
    if (b.coordinateMode !== 'direct' && b.coordinateMode !== 'all') {
      throw new Error("coordinateMode must be 'direct' or 'all'.");
    }
    coordinateMode = b.coordinateMode;
  }

  let excludeCategories: string[] = [];
  if (b.excludeCategories != null) {
    if (!Array.isArray(b.excludeCategories)) {
      throw new Error('excludeCategories must be an array of strings.');
    }
    if (b.excludeCategories.length > NEARBY_BOUNDS.maxExcludedCategories) {
      throw new Error(
        `excludeCategories must contain at most ${NEARBY_BOUNDS.maxExcludedCategories} entries.`,
      );
    }
    for (const c of b.excludeCategories) {
      if (typeof c !== 'string' || !c.trim() || c.length > 40) {
        throw new Error('excludeCategories entries must be non-empty strings of at most 40 characters.');
      }
    }
    excludeCategories = (b.excludeCategories as string[]).map((c) => c.trim());
  }

  let includeUniversal = false;
  if (b.includeUniversal != null) {
    if (typeof b.includeUniversal !== 'boolean') {
      throw new Error('includeUniversal must be a boolean.');
    }
    includeUniversal = b.includeUniversal;
  }

  const maxYear = new Date().getUTCFullYear() + 1;
  let fromYear: number | undefined;
  let toYear: number | undefined;
  for (const key of ['fromYear', 'toYear'] as const) {
    const value = b[key];
    if (value == null) continue;
    if (!finiteNumber(value) || !Number.isInteger(value)) {
      throw new Error(`${key} must be an integer year.`);
    }
    if (value < MIN_YEAR || value > maxYear) {
      throw new Error(`${key} must fall between ${MIN_YEAR} and ${maxYear}.`);
    }
    if (key === 'fromYear') fromYear = value;
    else toYear = value;
  }
  if (fromYear !== undefined && toYear !== undefined) {
    if (toYear < fromYear) throw new Error('toYear must not be before fromYear.');
    const span = toYear - fromYear + 1;
    if (span > NEARBY_BOUNDS.maxDateSpanYears) {
      throw new Error(
        `the date window spans ${span} years; the maximum is ${NEARBY_BOUNDS.maxDateSpanYears}.`,
      );
    }
  }

  return {
    lat: b.lat,
    lng: b.lng,
    radiusKm: b.radiusKm,
    limit,
    significanceFloor,
    coordinateMode,
    excludeCategories,
    includeUniversal,
    ...(fromYear !== undefined ? { fromYear } : {}),
    ...(toYear !== undefined ? { toYear } : {}),
  };
}
