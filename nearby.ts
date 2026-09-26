// ===================== Nearby events (v1) =====================
// Generic one-radius proximity retrieval. Product policy belongs to clients.

export const NEARBY_VERSION = 'geohistory-nearby@0.1.1';

export interface NearbyDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

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
  excludeCategories: string[];
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
  distanceKm: number;
  sourceUrl: string | null;
}

export interface NearbyResult {
  datasetVersion: string | null;
  /** Full layered artifact identity; changes on a re-score, re-reach, or prune. */
  datasetBuild: string | null;
  engine: string;
  radiusKm: number;
  coordinateMode: CoordinateMode;
  significanceFloor: number;
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

const EARTH_RADIUS_KM = 6371;
/** Conservative minimum meridional scale, so the prefilter contains the circle. */
const MIN_KM_PER_DEGREE_LAT = 110.574;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

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
  lngRanges: Array<[number, number]>;
}

/** Conservative, indexable superset of the exact haversine circle. */
export function boundingBox(lat: number, lng: number, radiusKm: number): BoundingBox {
  const latDelta = radiusKm / MIN_KM_PER_DEGREE_LAT;
  const minLat = lat - latDelta;
  const maxLat = lat + latDelta;

  if (minLat <= -90 || maxLat >= 90) {
    return {
      minLat: Math.max(-90, minLat),
      maxLat: Math.min(90, maxLat),
      lngRanges: [[-180, 180]],
    };
  }

  const widestLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const cos = Math.cos(toRadians(widestLat));
  if (cos <= 1e-9) return { minLat, maxLat, lngRanges: [[-180, 180]] };

  const lngDelta = latDelta / cos;
  if (lngDelta >= 180) return { minLat, maxLat, lngRanges: [[-180, 180]] };

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

function buildCandidateSql(input: NearbyInput, box: BoundingBox): {
  sql: string;
  params: Array<string | number>;
} {
  const params: Array<string | number> = [];
  const where: string[] = [
    'e.lat IS NOT NULL AND e.lng IS NOT NULL',
    'e.lat BETWEEN ? AND ?',
  ];
  params.push(box.minLat, box.maxLat);

  const lngClause = box.lngRanges.map(() => '(e.lng BETWEEN ? AND ?)').join(' OR ');
  where.push(`(${lngClause})`);
  for (const [lo, hi] of box.lngRanges) params.push(lo, hi);

  where.push('e.significance IS NOT NULL AND e.significance >= ?');
  params.push(input.significanceFloor);

  if (!input.includeUniversal) where.push("(e.scope IS NULL OR e.scope <> 'universal')");

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

  // Inclusive year overlap, matching core.ts. A ranged event beginning before
  // fromYear still belongs when date_end reaches into the requested window.
  if (input.fromYear !== undefined) {
    where.push(
      'CAST(substr(COALESCE(e.date_end, e.date_start), 1, 4) AS INTEGER) >= ?',
    );
    params.push(input.fromYear);
  }
  if (input.toYear !== undefined) {
    where.push('CAST(substr(e.date_start, 1, 4) AS INTEGER) <= ?');
    params.push(input.toYear);
  }

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

function readMeta(db: NearbyDatabase): Record<string, string> {
  const meta: Record<string, string> = {};
  try {
    for (const row of db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>) {
      meta[row.key] = row.value;
    }
  } catch {
    // Old files may not have meta.
  }
  return meta;
}

function datasetIdentity(meta: Record<string, string>): string | null {
  const ingest = meta.dataset_version || null;
  const scoring = meta.scoring_version || null;
  const reach = meta.reach_version || null;
  const prunes = [
    meta.last_prune,
    meta.last_series_prune,
    meta.last_dupe_prune,
    meta.last_media_prune,
    meta.last_universal_merge,
  ].filter((value): value is string => Boolean(value));
  if (!ingest && !scoring && !reach && prunes.length === 0) return null;
  return [
    ingest ?? 'unknown-ingest',
    scoring ?? 'unscored',
    reach ?? 'no-reach',
    prunes.length > 0 ? `prune${prunes.length}` : 'unpruned',
  ].join('+');
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function nearbyEvents(db: NearbyDatabase, input: NearbyInput): NearbyResult {
  const box = boundingBox(input.lat, input.lng, input.radiusKm);
  const { sql, params } = buildCandidateSql(input, box);
  const rows = db.prepare(sql).all(...params) as CandidateRow[];

  if (rows.length > NEARBY_BOUNDS.maxCandidateRows) {
    throw new NearbyOverflowError(
      `Candidate set exceeds ${NEARBY_BOUNDS.maxCandidateRows} rows; narrow the radius or date window.`,
    );
  }

  const withDistance = rows
    .map((row) => ({ row, distanceKm: haversineKm(input.lat, input.lng, row.lat, row.lng) }))
    .filter((candidate) => candidate.distanceKm <= input.radiusKm);

  withDistance.sort((a, b) =>
    a.distanceKm !== b.distanceKm
      ? a.distanceKm - b.distanceKm
      : a.row.date_start !== b.row.date_start
        ? compareText(a.row.date_start, b.row.date_start)
        : compareText(a.row.id, b.row.id),
  );

  const selected = withDistance.slice(0, input.limit);
  selected.sort((a, b) =>
    a.row.date_start !== b.row.date_start
      ? compareText(a.row.date_start, b.row.date_start)
      : a.distanceKm !== b.distanceKm
        ? a.distanceKm - b.distanceKm
        : compareText(a.row.id, b.row.id),
  );

  const meta = readMeta(db);
  return {
    datasetVersion: meta.dataset_version ?? null,
    datasetBuild: datasetIdentity(meta),
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
  'lat', 'lng', 'radiusKm', 'limit', 'significanceFloor', 'coordinateMode',
  'excludeCategories', 'includeUniversal', 'fromYear', 'toYear',
]);
const MIN_YEAR = 1;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateNearbyInput(body: unknown): NearbyInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((key) => !ACCEPTED_FIELDS.has(key));
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

  let limit: number = NEARBY_BOUNDS.limit.default;
  if (b.limit != null) {
    if (!finiteNumber(b.limit) || !Number.isInteger(b.limit)) throw new Error('limit must be an integer.');
    if (b.limit < NEARBY_BOUNDS.limit.min || b.limit > NEARBY_BOUNDS.limit.max) {
      throw new Error(`limit must be between ${NEARBY_BOUNDS.limit.min} and ${NEARBY_BOUNDS.limit.max}.`);
    }
    limit = b.limit;
  }

  let significanceFloor: number = NEARBY_BOUNDS.significanceFloor.default;
  if (b.significanceFloor != null) {
    if (!finiteNumber(b.significanceFloor)) throw new Error('significanceFloor must be a number.');
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
    for (const category of b.excludeCategories) {
      if (typeof category !== 'string' || !category.trim() || category.length > 40) {
        throw new Error('excludeCategories entries must be non-empty strings of at most 40 characters.');
      }
    }
    excludeCategories = (b.excludeCategories as string[]).map((category) => category.trim());
  }

  let includeUniversal = false;
  if (b.includeUniversal != null) {
    if (typeof b.includeUniversal !== 'boolean') throw new Error('includeUniversal must be a boolean.');
    includeUniversal = b.includeUniversal;
  }

  const maxYear = new Date().getUTCFullYear() + 1;
  let fromYear: number | undefined;
  let toYear: number | undefined;
  for (const key of ['fromYear', 'toYear'] as const) {
    const value = b[key];
    if (value == null) continue;
    if (!finiteNumber(value) || !Number.isInteger(value)) throw new Error(`${key} must be an integer year.`);
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
      throw new Error(`the date window spans ${span} years; the maximum is ${NEARBY_BOUNDS.maxDateSpanYears}.`);
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
