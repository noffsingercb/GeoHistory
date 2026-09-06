import Database from 'better-sqlite3';
import { isInstitution } from './classify';

// ===================== Build-time scorer =====================
// Two independently-patchable passes, both fully deterministic and baked into the
// static file. The (future) LLM refiner plugs into pass 1; pass 2 is a pure formula.
//
//   npm run score            -> run both passes (scores, then reach)
//   npm run score scores     -> pass 1 only (scope + significance)
//   npm run score reach      -> pass 2 only (reach_km + bbox) -- the cheap no-LLM patch
//
// v0.7 scoring (dataset v0.6):
//   - scope 'universal' (seed.ts) is never re-derived: significance pinned to 1.0,
//     reach = the whole globe. These rows are drawn by core.ts for every life that
//     overlaps them, with no distance test.
//   - rows expanded from a war's participant list (expand-participants.ts,
//     coord_source = 'P710') keep their authored 'national' scope: they exist so
//     the US centroid carries World War II to an Ohio life.
//   - recency taper (ERA_TAPER): Wikipedia documents the recent past far more
//     densely than any earlier era, and controversial modern events attract the
//     most sitelinks of all, so raw notability sends a 2020 protest to 'global'
//     alongside the World Wars. The taper scales the notability that feeds the
//     SCOPE LADDER for history rows dated after 1950 -- gently at first, hardest
//     in the last 15-20 years -- so recent events draw a smaller radius and
//     appear on timelines near where they happened. It does NOT touch the stored
//     notability, and it does not change significance: significance is a
//     percentile within the row's own decade, and scaling every row in a decade
//     by the same factor leaves that ranking exactly as it was.
//   - 'disaster' has its own ladder: a pandemic or famine at notability 0.8 is
//     global news; an air crash at 0.3 is national; a mine accident at 0.1 stays
//     regional/local.
//   - a row placed at a country centroid (coord_source P17 / P495) can never be
//     'local' or 'regional': the point is fuzzy by hundreds of km.

const MODE = (process.argv[2] ?? 'all').toLowerCase(); // 'all' | 'scores' | 'reach'
const SCORING_VERSION = 'struct-v0.7';
const REACH_VERSION = 'reach-v0.3';
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

type Scope = 'local' | 'regional' | 'national' | 'global' | 'universal';

// ---------- migration (idempotent; lets the scorer run on pre-scoring DBs) ----------
function migrate(): void {
  const cols = [
    'significance REAL', 'reach_km REAL',
    'reach_min_lat REAL', 'reach_max_lat REAL', 'reach_min_lng REAL', 'reach_max_lng REAL',
    'founding_kind TEXT',
  ];
  for (const c of cols) {
    try { db.exec(`ALTER TABLE events ADD COLUMN ${c};`); } catch { /* column already exists */ }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_significance ON events(significance);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_reach_box ON events(reach_min_lat, reach_max_lat, reach_min_lng, reach_max_lng);`);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`);
}

function setMeta(key: string, value: string): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// ---------- recency taper ----------
// Piecewise-linear multiplier on ladder notability by START year. Anchor points;
// linear between them; flat outside. Tune here, then `npm run score` (minutes).
//
//   <= 1950  1.00   pre-television history: sitelinks track importance well enough
//      1990  0.90   gentle: the Cold War decades are well covered but not inflated
//      2006  0.80   the modern internet era begins to over-document everything
//      2026  0.55   the last 15-20 years: heaviest; a story needs ~1.8x the
//                   sitelinks of a 1940 event to reach the same scope rung
//
// Universal rows are exempt (9/11 and COVID-19 belong on every timeline by
// decision, not by score) and so are seed rows, whose scope is authored.
const ERA_TAPER: Array<[year: number, factor: number]> = [
  [1950, 1.0],
  [1990, 0.9],
  [2006, 0.8],
  [2026, 0.55],
];
function eraFactor(year: number): number {
  if (!Number.isFinite(year) || year <= ERA_TAPER[0][0]) return ERA_TAPER[0][1];
  for (let i = 1; i < ERA_TAPER.length; i++) {
    const [y0, f0] = ERA_TAPER[i - 1];
    const [y1, f1] = ERA_TAPER[i];
    if (year <= y1) return f0 + ((year - y0) / (y1 - y0)) * (f1 - f0);
  }
  return ERA_TAPER[ERA_TAPER.length - 1][1];
}

// ---------- pass 1: scope + significance ----------
// Scope (geographic reach class) from category + absolute fame. Thresholds are
// tuned so world-shaping conflicts/events/discoveries become GLOBAL and reach
// everyone alive at the time (a WWII battle is context for a Chicagoan, not just
// for people near the battlefield). This is the structural baseline; the LLM
// refiner will later overwrite these labels semantically.
//
// FOUNDING is a special case. Before v0.6 the ingest discarded P31, so a
// settlement's incorporation and a territory's statehood were indistinguishable
// here, and the notability ladder below sent both to 'national' (a 1,950 km reach)
// whenever the place is well known today. But sitelink count measures a place's
// PRESENT-DAY prominence, not how far the news of its founding actually travelled
// at the time. rescope-foundings.ts recovers the distinction (from wikidata_types
// on v0.6 rows, from events.blurb on older ones) into founding_kind; when it is
// set, it overrides the ladder.
const FOUNDING_KIND_SCOPE: Record<string, (notability: number) => Scope> = {
  settlement: () => 'local',                                     // a town coming into existence is local news
  city: () => 'regional',                                        // a CITY (Q515 / big city) forming is regional news: Chicago 1837 mattered to Illinois, not to Georgia
  // Deliberately 'national' rather than 'regional'. Admission to a federation --
  // New Mexico, Arizona and Oklahoma becoming states in 1907-1912 -- genuinely was
  // national news, and a regional 390 km cap dropped all of them out of a Pueblo,
  // CO timeline covering exactly those years. The cost is that provinces, counties
  // and departments created by administrative fiat are overweighted here. The
  // current data cannot separate the two cases (both are bare P571 place items),
  // and losing real statehood is the worse error. Revisit when P31 is retained.
  subnational: () => 'national',
  country: (n) => (n >= 0.6 ? 'global' : 'national'),            // independence / founding of a nation
  institution: (n) => INSTITUTION_SCOPE(n),                      // see below
};

// An institution's FOUNDING is local or regional news no matter how famous the
// institution later becomes. Notability cannot tell the difference, because it is
// sitelinks/100 -- a measure of present-day prominence. That is how York University
// (notability 1.0, category 'event') reached global scope and a 20,038 km radius,
// putting a 1959 Toronto campus opening ahead of the Depression, WWII and the moon
// landing on a Charleston WV timeline.
//
// Regional (300 km) is the ceiling: a major university or company genuinely is
// regional news when it opens. Below 0.5 it is local, which is where a suburban
// campus or a single hospital belongs.
const INSTITUTION_SCOPE = (notability: number): Scope => (notability >= 0.5 ? 'regional' : 'local');

// Fallback-placed rows sit at a country (P17) or country-of-origin (P495)
// centroid. Whatever the ladder says, that point is not a neighbourhood.
const CENTROID_SOURCES = new Set(['P17', 'P495']);
const SCOPE_RANK: Record<Scope, number> = { local: 0, regional: 1, national: 2, global: 3, universal: 4 };

function scopeFor(
  category: string | null,
  notability: number,
  foundingKind: string | null = null,
  blurb: string | null = null,
  coordSource: string | null = null,
): Scope {
  const ladder = ladderScope(category, notability, foundingKind, blurb);
  if (coordSource && CENTROID_SOURCES.has(coordSource) && SCOPE_RANK[ladder] < SCOPE_RANK.national) return 'national';
  return ladder;
}

function ladderScope(
  category: string | null,
  notability: number,
  foundingKind: string | null,
  blurb: string | null,
): Scope {
  // Applies across categories because the ingest files institutions inconsistently:
  // York University landed in 'event', DeVry University in 'event', and others in
  // 'founding'. Person rows are exempt -- they are already local, and a blurb like
  // "founder of the university" should not reclassify the person.
  if (category !== 'birth' && category !== 'death' && isInstitution(blurb)) {
    return INSTITUTION_SCOPE(notability);
  }

  switch (category) {
    case 'election':  return notability >= 0.5 ? 'national' : 'regional';
    case 'conflict':  return notability >= 0.6 ? 'global' : notability >= 0.3 ? 'national' : notability >= 0.15 ? 'regional' : 'local';
    // Disasters: pandemics, famines and the worst earthquakes are world news; a
    // named storm, crash or mine collapse is national at most; the long tail of
    // reported accidents (floor 5 sitelinks since dump-v0.6) stays regional/local.
    case 'disaster':  return notability >= 0.8 ? 'global' : notability >= 0.4 ? 'national' : notability >= 0.2 ? 'regional' : 'local';
    case 'founding': {
      const byKind = foundingKind ? FOUNDING_KIND_SCOPE[foundingKind] : undefined;
      if (byKind) return byKind(notability);
      return notability >= 0.75 ? 'national' : notability >= 0.4 ? 'regional' : 'local';
    }
    // Was `notability >= 0.4 ? 'global' : 'national'` -- two rungs, with no way to
    // express anything below national. Every obscure discovery therefore carried a
    // 1,050+ km reach: Griffin Television Tower Oklahoma, notability 0.07, was
    // national context for a quarter of a continent. Now a full 4-tier ladder,
    // matching the shape already used by milestone and event.
    case 'discovery': return notability >= 0.4 ? 'global' : notability >= 0.2 ? 'national' : notability >= 0.1 ? 'regional' : 'local';
    // milestone (inventions / first-of-its-kind): full 4-tier ladder so minor
    // novelties stay local while world-changing firsts reach everyone.
    case 'milestone': return notability >= 0.75 ? 'global' : notability >= 0.45 ? 'national' : notability >= 0.25 ? 'regional' : 'local';
    case 'treaty':    return notability >= 0.6 ? 'global' : notability >= 0.3 ? 'national' : 'regional';
    case 'event':     return notability >= 0.6 ? 'global' : notability >= 0.35 ? 'national' : notability >= 0.2 ? 'regional' : 'local';
    case 'birth':
    case 'death':     return 'local'; // a person's birth/death reaches locally; their fame lives in significance
    default:          return notability >= 0.6 ? 'national' : 'local';
  }
}

// Person rows are ranked against other person rows, never against history.
//
// Two different instruments feed `notability`. Dump events use sitelinks/100 with
// per-category floors as low as 3 sitelinks, so their long tail sits at 0.03-0.12.
// Humans enter at a 30-sitelink floor, so every person row starts at 0.30 by
// construction. Percentiling both against one decade-wide distribution meant a
// decade's biographical volume decided what counted as significant history: a
// curated county-level event at notability 0.12 was ranked below every birth and
// death in the decade and fell under the engine's significance floor, while the
// births themselves were flattered by the events' long tail.
//
// Splitting the two populations makes significance mean "important for its kind,
// in its decade", which is what both the engine floor and the per-tier draw in
// core.ts assume it means. Measured over 107k rows, the split lands history at
// mean significance 0.530 and persons at 0.517 -- each population centered on its
// own median, which is the whole point.
const PERSON_CATEGORIES = new Set(['birth', 'death']);
const isPersonRow = (category: string | null): boolean => PERSON_CATEGORIES.has(category ?? '');

interface ScoreRow {
  id: string; category: string | null; notability: number | null; date_start: string | null; scope: string | null;
  ingest_version: string | null; founding_kind: string | null; blurb: string | null; coord_source: string | null;
}

function runScoring(): void {
  const rows = db.prepare(`SELECT id, category, notability, date_start, scope, ingest_version, founding_kind, blurb, coord_source FROM events`).all() as ScoreRow[];

  // Era-normalize: significance = percentile of notability WITHIN the event's decade,
  // among rows of the same kind (person vs history). This is what keeps sparse
  // historical decades from being buried under modern volume.
  const yearOf = (ds: string | null): number => parseInt(String(ds ?? '').slice(0, 4), 10);
  const decadeOf = (ds: string | null): number => {
    const y = yearOf(ds);
    return Number.isFinite(y) ? Math.floor(y / 10) * 10 : 0;
  };
  const byDecade = { person: new Map<number, number[]>(), history: new Map<number, number[]>() };
  const bucketOf = (r: ScoreRow) => (isPersonRow(r.category) ? byDecade.person : byDecade.history);
  for (const r of rows) {
    const d = decadeOf(r.date_start);
    const map = bucketOf(r);
    let arr = map.get(d);
    if (!arr) { arr = []; map.set(d, arr); }
    arr.push(typeof r.notability === 'number' ? r.notability : 0);
  }
  for (const map of [byDecade.person, byDecade.history]) {
    for (const arr of map.values()) arr.sort((a, b) => a - b);
  }

  const percentile = (map: Map<number, number[]>, decade: number, n: number): number => {
    const arr = map.get(decade);
    if (!arr || arr.length <= 1) return 0.5;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= n) lo = mid + 1; else hi = mid; }
    return lo / arr.length;
  };

  const upd = db.prepare(`UPDATE events SET scope = @scope, significance = @significance WHERE id = @id`);
  let byKind = 0;
  let persons = 0;
  let institutions = 0;
  let demoted = 0;
  let universal = 0;
  let expanded = 0;
  let tapered = 0;      // history rows whose ladder rung dropped because of the era taper
  let liftedCentroid = 0;
  const globalByDecade = new Map<number, number>(); // taper QA: global rows per decade from 1900
  const tx = db.transaction((items: ScoreRow[]) => {
    for (const r of items) {
      const notability = typeof r.notability === 'number' ? r.notability : 0;
      const map = bucketOf(r);
      if (isPersonRow(r.category)) persons++;
      const isSeed = typeof r.ingest_version === 'string' && r.ingest_version.startsWith('seed-');
      const isUniversal = r.scope === 'universal';
      const isExpanded = r.coord_source === 'P710';
      if (r.category === 'founding' && r.founding_kind && FOUNDING_KIND_SCOPE[r.founding_kind]) byKind++;

      let scope: Scope;
      let significance: number;
      if (isUniversal) {
        // Always shown: pinned above every floor, drawn by core.ts's universal quota.
        scope = 'universal';
        significance = 1;
        universal++;
      } else if ((isSeed || isExpanded) && r.scope) {
        // Curated seed rows carry an authored scope; participant-expanded rows carry
        // 'national' by construction. Preserve both rather than deriving from the formula.
        scope = r.scope as Scope;
        significance = Math.round(percentile(map, decadeOf(r.date_start), notability) * 1000) / 1000;
        if (isExpanded) expanded++;
      } else {
        const taper = isPersonRow(r.category) ? 1 : eraFactor(yearOf(r.date_start));
        const ladderNotability = notability * taper;
        scope = scopeFor(r.category, ladderNotability, r.founding_kind, r.blurb, r.coord_source);
        if (taper < 1 && SCOPE_RANK[scope] < SCOPE_RANK[scopeFor(r.category, notability, r.founding_kind, r.blurb, r.coord_source)]) tapered++;
        if (r.coord_source && CENTROID_SOURCES.has(r.coord_source) && SCOPE_RANK[ladderScope(r.category, ladderNotability, r.founding_kind, r.blurb)] < SCOPE_RANK.national) liftedCentroid++;
        significance = Math.round(percentile(map, decadeOf(r.date_start), notability) * 1000) / 1000;
      }

      if (!isSeed && !isUniversal && !isPersonRow(r.category) && isInstitution(r.blurb)) {
        institutions++;
        // Reported so a bad pattern shows up as a spike rather than silently
        // shrinking half the corpus.
        if (r.scope === 'global' || r.scope === 'national') demoted++;
      }
      if (scope === 'global' && !isPersonRow(r.category)) {
        const d = decadeOf(r.date_start);
        if (d >= 1900) globalByDecade.set(d, (globalByDecade.get(d) ?? 0) + 1);
      }
      upd.run({ id: r.id, scope, significance });
    }
  });
  tx(rows);
  setMeta('scoring_version', SCORING_VERSION);
  setMeta('scored_at', new Date().toISOString());
  setMeta('era_taper', JSON.stringify(ERA_TAPER));
  console.log(`Pass 1: scored ${rows.length} events (scope + era-normalized significance; authored scope preserved for seed rows).`);
  console.log(`  percentiled separately: ${(rows.length - persons).toLocaleString()} history rows, ${persons.toLocaleString()} person rows (birth/death).`);
  console.log(`  universal rows pinned (scope universal, significance 1.0): ${universal.toLocaleString()}.`);
  console.log(`  participant-expanded rows kept national (coord_source P710): ${expanded.toLocaleString()}.`);
  console.log(`  founding rows scoped by founding_kind: ${byKind.toLocaleString()} (run "npm run rescope:foundings" to classify more).`);
  console.log(`  institution rows capped at regional/local: ${institutions.toLocaleString()} (${demoted.toLocaleString()} were previously national or global).`);
  console.log(`  recency taper lowered the scope rung of ${tapered.toLocaleString()} post-1950 history rows; centroid-placed rows lifted to national: ${liftedCentroid.toLocaleString()}.`);
  console.log('  global (non-person) rows per decade since 1900 -- a flat-ish line means the taper is doing its job:');
  const decades = [...globalByDecade.keys()].sort((a, b) => a - b);
  console.log('    ' + decades.map((d) => `${d}s:${globalByDecade.get(d)}`).join('  '));
}

// ---------- pass 2: reach_km + bounding box (pure formula; the cheap patch) ----------
const SCOPE_BASE_KM: Record<Scope, number> = { local: 50, regional: 300, national: 1500, global: 20038, universal: 20038 };

// How much significance is allowed to stretch a tier's radius, as base * (floor + span * sig).
//
// The local tier is deliberately flat, and its floor is 1.0 rather than something
// less. "Local" should be a stable neighborhood radius, not a fame-scaled one: if
// a local event 45 km away reaches you but an equally local one at 55 km does not,
// that is an artifact of percentile rank, not of geography. Under the shared
// 0.7 + 0.6s curve a 40 km base spanned 28-64 km and needed significance >= 0.92
// to clear 50 km, i.e. never. An intermediate 0.9 + 0.2s was no better in the way
// that matters -- it spans 45-55 km, so half the tier still fell short of 50.
//
// At 1.0 + 0.2s every local row reaches a full 50 km and significance only extends
// it, to a 60 km ceiling that is still tighter than the 64 km the original curve
// allowed. Tiers above local keep the original curve, where a fame-scaled spread
// is meaningful.
const REACH_CURVE: Record<Scope, { floor: number; span: number }> = {
  local:     { floor: 1.0, span: 0.2 },
  regional:  { floor: 0.7, span: 0.6 },
  national:  { floor: 0.7, span: 0.6 },
  global:    { floor: 0.7, span: 0.6 },
  universal: { floor: 1.0, span: 0.0 },
};

interface ReachRow { id: string; lat: number | null; lng: number | null; scope: string | null; significance: number | null; }

function runReach(): void {
  // Universal rows are included even without coordinates (an era has no point).
  const rows = db.prepare(`SELECT id, lat, lng, scope, significance FROM events WHERE (lat IS NOT NULL AND lng IS NOT NULL) OR scope = 'universal'`).all() as ReachRow[];
  const upd = db.prepare(`
    UPDATE events
    SET reach_km = @reach_km, reach_min_lat = @minLat, reach_max_lat = @maxLat, reach_min_lng = @minLng, reach_max_lng = @maxLng
    WHERE id = @id
  `);
  const tx = db.transaction((items: ReachRow[]) => {
    for (const r of items) {
      const scope = (r.scope ?? 'local') as Scope;
      const sig = typeof r.significance === 'number' ? r.significance : 0;
      const base = SCOPE_BASE_KM[scope] ?? SCOPE_BASE_KM.local;
      const curve = REACH_CURVE[scope] ?? REACH_CURVE.local;

      let reach_km: number, minLat: number, maxLat: number, minLng: number, maxLng: number;
      if (scope === 'global' || scope === 'universal') {
        reach_km = SCOPE_BASE_KM.global; // half Earth circumference -> matches everywhere
        minLat = -90; maxLat = 90; minLng = -180; maxLng = 180;
      } else {
        const lat = r.lat as number;
        const lng = r.lng as number;
        reach_km = Math.round(base * (curve.floor + curve.span * sig)); // more significant -> reaches a bit further
        const dLat = reach_km / 111;
        const dLng = reach_km / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
        minLat = Math.max(-90, lat - dLat); maxLat = Math.min(90, lat + dLat);
        minLng = lng - dLng; maxLng = lng + dLng;
        if (dLng >= 180) { minLng = -180; maxLng = 180; } // antimeridian-safe fallback
      }
      upd.run({ id: r.id, reach_km, minLat, maxLat, minLng, maxLng });
    }
  });
  tx(rows);
  setMeta('reach_version', REACH_VERSION);
  setMeta('reached_at', new Date().toISOString());
  console.log(`Pass 2: materialized reach + bbox for ${rows.length} events.`);
}

// ===================== Main =====================
migrate();
if (MODE === 'all' || MODE === 'scores') runScoring();
if (MODE === 'all' || MODE === 'reach') runReach();

try {
  const top = db.prepare(`SELECT ingest_version AS v, COUNT(*) AS c FROM events GROUP BY ingest_version ORDER BY c DESC LIMIT 1`).get() as { v?: string } | undefined;
  if (top?.v) setMeta('dataset_version', String(top.v));
} catch { /* ignore */ }

db.close();
console.log('Done. To retune relevance without rescoring, edit the pass-2 formula and run: npm run score reach');
