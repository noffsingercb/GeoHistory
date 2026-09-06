import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

// ===================== Comprehensive dump ingester (dump-v0.6) =====================
// Harvests the full geo-located event dataset from a LOCAL Wikidata JSON dump
// (no live SPARQL -> no rate limits, fully reproducible). Two streaming passes:
//
//   Pass 1 (coords): index every Earth coordinate (P625) + subclass edges (P279)
//   -> closure step expands category root types into their full descendant sets
//   Pass 2 (events): classify + extract each event WITH true Wikidata date precision
//
// Download the dump first (~140 GB gzip; it is streamed, never unpacked to disk):
//   https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz
//
// Usage (PowerShell): point WIKIDATA_DUMP at the dump, then: npm run ingest:dump
// Validate on a slice first via INGEST_MAX_LINES, then run the post-passes in one go:
//   npm run post-ingest     (= seed, prune:dupes, prune:series, rescope:foundings,
//                            score, expand:participants, score, titles)
//
// DESIGN RULE (v0.6): a full pass over the dump takes 8-10 hours, so this script
// only harvests raw, structured facts (dates, coordinates, types, sitelinks,
// participants, containing places). Every JUDGEMENT -- scope, the recency taper,
// national-tier rows for overseas wars, display titles, pruning -- lives in the
// post-ingest scripts, which run in minutes and can be re-run without touching
// the dump. If a scoring idea needs a fact this script does not keep, add the
// COLUMN here; never add the judgement.
//
// Start from an EMPTY database file (GEOHISTORY_DB, default events.sqlite).
// Inserts are INSERT OR IGNORE, so a re-run over an existing file keeps every
// old row exactly as it was; the script refuses a pre-v0.6 file outright.
//
// What dump-v0.6 changes against the shipped dump-v0.5 data:
//   - date_end from P582 for ranged categories, so a war or pandemic overlaps
//     every life segment it ran through once core.ts filters on the range
//     instead of the start year (the World Wars were a single-year event before)
//   - coordinate fallback P625 -> P276 location -> P17 country -> P495 country
//     of origin for conflicts, disasters, elections, treaties and big events.
//     Wars and pandemics rarely carry a point of their own and were dropped.
//     coord_source records which claim placed the row so score.ts can refuse
//     to call a country-centroid row 'local'
//   - Earth coordinates only (globe Q2): lunar and martian P625 values used to
//     land Apollo sites in the Atlantic
//   - disaster category (disasters, epidemics/pandemics, famines) instead of
//     hoping they descend from the generic 'occurrence' root
//   - historical countries (Q3024240) as a founding root: Soviet Union 1922,
//     Irish Free State 1922, Confederate States 1861
//   - sitelinks, wikidata_types (P31 list) and category_root kept on every row
//     so the scorer and the title/kind classifiers stop guessing from prose
//   - participants (P710; P1891 signatories for treaties) and country_id (P17)
//     kept as raw QIDs. expand-participants.ts turns 'World War II' into a
//     national-tier 'World War II - United States' row at the US centroid, so a
//     war fought overseas still reaches the lives of the countries that fought it
//   - place_id = P131 containing division (else P17), and the places table is
//     filled with every country / admin1 / county entity met in the stream, so
//     display-titles.ts can write 'Founding of Toronto, Ohio' instead of a bare
//     duplicate, and expand-participants.ts has a name + centroid per country
//   - accidents (Q171558: air crashes, mine and rail disasters) join the
//     disaster category, and its floors drop (8 -> 5 sitelinks, fallback 15 -> 12):
//     users reported well-known disasters missing from v0.5
//   - terrorist attacks (Q2223653) are an explicit event root
//   - deaths (P1120) kept raw for later scoring experiments

const __dirname = dirname(fileURLToPath(import.meta.url));

const DUMP = process.env.WIKIDATA_DUMP;
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';
const START_YEAR = parseInt(process.env.INGEST_START_YEAR ?? '1275', 10); // ~750 years back
const END_YEAR = parseInt(process.env.INGEST_END_YEAR ?? String(new Date().getUTCFullYear()), 10);
const MAX_LINES = process.env.INGEST_MAX_LINES ? parseInt(process.env.INGEST_MAX_LINES, 10) : 0; // 0 = no limit
const PASS = (process.env.INGEST_PASS ?? 'all').toLowerCase(); // 'coords' | 'events' | 'all'
const INGEST_VERSION = 'dump-v0.6';

if (!DUMP || !fs.existsSync(DUMP)) {
  console.error('Set WIKIDATA_DUMP to a local latest-all.json.gz path. Download: https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = OFF');
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
// schema.sql opens with PRAGMA foreign_keys = ON, which re-enables enforcement on
// this connection. Pass 2 writes events.place_id / places.parent_id BEFORE (or
// without ever) meeting the referenced place in the stream, so enforcement must
// stay off for the build. Consumers open the file with SQLite's default (off).
db.pragma('foreign_keys = OFF');

// CREATE TABLE IF NOT EXISTS is a no-op on an existing file, so a v0.5 database
// would sail through pass 1 and then die on the first INSERT hours later.
{
  const cols = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((c) => c.name));
  for (const c of ['date_end', 'coord_source', 'category_root', 'wikidata_types', 'sitelinks', 'country_id', 'participants', 'deaths']) {
    if (!cols.has(c)) {
      console.error(`${DB_PATH} predates schema v0.6 (missing events.${c}). Ingest into an empty file (Rename-Item events.sqlite events.v05.sqlite) or run: npm run migrate`);
      process.exit(1);
    }
  }
}

// Scratch indexes used only during the build (gitignored DB). Drop them before
// publishing: sqlite3 events.sqlite "DROP TABLE _coords; DROP TABLE _subclass; VACUUM;"
db.exec(`CREATE TABLE IF NOT EXISTS _coords (qid TEXT PRIMARY KEY, lat REAL, lng REAL);`);
db.exec(`CREATE TABLE IF NOT EXISTS _subclass (child TEXT, parent TEXT);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_subclass_parent ON _subclass(parent);`);

// ---------- category definitions (root types + which date props carry the event date) ----------
// coordMode controls how an event is placed; coord_source on the row records which claim won:
//   'p625'            -> require the event's own Earth P625 coordinate (default)
//   'p625_then_place' -> own P625, else the PLACE_PROPS chain (location -> country -> country of origin)
//   'place_first'     -> PLACE_PROPS chain first, else own P625 (milestones: their own point is a
//                        launch pad at best, and used to be the Moon before the Earth-only filter)
// fallbackFloor: the fallback chain is only consulted at or above this many sitelinks. A row placed
// at a centroid is scored national or wider, so only rows that plausibly ARE national get one.
type CoordMode = 'p625' | 'p625_then_place' | 'place_first';
interface CategoryDef { category: string; roots: string[]; dateProps: string[]; floor: number; coordMode?: CoordMode; fallbackFloor?: number; }
const CATEGORIES: CategoryDef[] = [
  { category: 'conflict',  roots: ['Q180684', 'Q198', 'Q178561', 'Q831663'],             dateProps: ['P585', 'P580'], floor: 5,  coordMode: 'p625_then_place', fallbackFloor: 20 },
  { category: 'disaster',  roots: ['Q3839081', 'Q8065', 'Q44512', 'Q12184', 'Q168247', 'Q171558'], dateProps: ['P585', 'P580'], floor: 5, coordMode: 'p625_then_place', fallbackFloor: 12 },
  { category: 'election',  roots: ['Q40231'],                                            dateProps: ['P585', 'P580'], floor: 12, coordMode: 'p625_then_place' },
  { category: 'treaty',    roots: ['Q131569'],                                           dateProps: ['P585', 'P580'], floor: 10, coordMode: 'p625_then_place' },
  { category: 'founding',  roots: ['Q6256', 'Q3624078', 'Q3024240', 'Q515', 'Q3957', 'Q532', 'Q10864048', 'Q1549591'], dateProps: ['P571'], floor: 5 },
  { category: 'discovery', roots: ['Q12772819', 'Q11019'],                               dateProps: ['P575', 'P571'], floor: 3 },
  { category: 'milestone', roots: ['Q5916', 'Q495307'],                                  dateProps: ['P585', 'P580', 'P575', 'P571'], floor: 25, coordMode: 'place_first' },
  { category: 'event',     roots: ['Q2223653', 'Q1190554', 'Q1656682'],                  dateProps: ['P585', 'P580'], floor: 8,  coordMode: 'p625_then_place', fallbackFloor: 40 },
];
// conflict roots:  Q180684 conflict, Q198 war, Q178561 battle, Q831663 military campaign
// disaster roots:  Q3839081 disaster, Q8065 natural disaster, Q44512 epidemic, Q12184 pandemic, Q168247 famine,
//                  Q171558 accident (aviation / rail / mining / industrial accidents; floor 5 keeps it to reported ones)
// founding roots:  Q6256 country, Q3624078 sovereign state, Q3024240 historical country, Q515 city, Q3957 town,
//                  Q532 village, Q10864048 first-level administrative division, Q1549591 big city
// discovery roots: Q12772819 discovery, Q11019 machine (inventions)
// milestone roots: Q5916 spaceflight, Q495307 space mission
// event roots:     Q2223653 terrorist attack (explicit, so it never depends on the occurrence closure), Q1190554 occurrence, Q1656682 event
const RANGED = new Set(['conflict', 'disaster', 'event', 'milestone']); // categories whose P582 becomes date_end

// Which claim lists an event's participating parties, per category. Stored raw
// (QIDs, capped); expand-participants.ts resolves them against places.
const PARTICIPANT_PROPS: Record<string, string[]> = {
  conflict: ['P710'],          // participant
  treaty:   ['P1891', 'P710'], // signatory, else participant
  event:    ['P710'],
  disaster: ['P710'],
};
const MAX_PARTICIPANTS = 64;

// places harvest (pass 2): P31 closure roots -> places.level. A row here is NOT an
// event; it is the containment chain events point into via place_id / country_id.
// Order = priority (first hit wins): a city-state typed both country and city is a country.
const PLACE_LEVELS: Array<{ level: 'country' | 'admin1' | 'county'; roots: string[] }> = [
  { level: 'country', roots: ['Q6256', 'Q3624078', 'Q3024240', 'Q1763527'] }, // country, sovereign state, historical country, constituent country
  { level: 'admin1',  roots: ['Q10864048'] },                                 // first-level administrative division (US state, province, oblast)
  { level: 'county',  roots: ['Q13220204'] },                                 // second-level administrative division (county, district, arrondissement)
];
const MAX_ALIASES = 8;
const HUMAN_FLOOR = 30; // sitelink floor for births/deaths (keeps the file to notable people)
const EARTH_GLOBE = 'http://www.wikidata.org/entity/Q2';
const PLACE_PROPS = ['P276', 'P17', 'P495']; // location, country, country of origin -- in fallback order
const MAX_TYPES = 12;       // P31 values kept per row
const MAX_SPAN_YEARS = 100; // anything longer is a period or a series, not an event a life overlaps

// ===================== dump streaming =====================
function streamDump(onEntity: (e: any) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(DUMP as string).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });
    let n = 0;
    rl.on('line', (raw) => {
      n++;
      const line = raw.trim().replace(/,$/, '');
      if (line.length < 2 || line === '[' || line === ']') { maybeStop(); return; }
      let e: any;
      try { e = JSON.parse(line); } catch { maybeStop(); return; }
      if (e && e.type === 'item' && typeof e.id === 'string' && e.id[0] === 'Q') onEntity(e);
      maybeStop();
      function maybeStop() {
        if (n % 500000 === 0) console.log(`  ...scanned ${n.toLocaleString()} lines`);
        if (MAX_LINES && n >= MAX_LINES) rl.close();
      }
    });
    rl.on('close', () => resolve(n));
    rl.on('error', reject);
  });
}

// ===================== helpers =====================
const instanceIds = (e: any): string[] =>
  (e.claims?.P31 ?? []).map((c: any) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean);

function sitelinkCount(e: any): number { return e.sitelinks ? Object.keys(e.sitelinks).length : 0; }

// First P625 that is on Earth. Wikidata coordinates carry a globe; lunar craters,
// martian landing sites and asteroid features have perfectly valid lat/lng
// values that mean nothing here.
function firstCoordinate(e: any): { lat: number; lng: number } | null {
  for (const c of (e.claims?.P625 ?? [])) {
    const v = c?.mainsnak?.datavalue?.value;
    if (!v || typeof v.latitude !== 'number' || typeof v.longitude !== 'number') continue;
    if (v.globe && v.globe !== EARTH_GLOBE) continue;
    return { lat: v.latitude, lng: v.longitude };
  }
  return null;
}

function firstItemId(e: any, prop: string): string | null {
  return (e.claims?.[prop] ?? [])[0]?.mainsnak?.datavalue?.value?.id ?? null;
}

// Every item-valued claim of a property, in statement order, de-duplicated.
function itemIds(e: any, prop: string, max = MAX_PARTICIPANTS): string[] {
  const out: string[] = [];
  for (const c of (e.claims?.[prop] ?? [])) {
    const id = c?.mainsnak?.datavalue?.value?.id;
    if (typeof id === 'string' && id[0] === 'Q' && !out.includes(id)) {
      out.push(id);
      if (out.length >= max) break;
    }
  }
  return out;
}

// First value among several properties, as a JSON array string, or null when none.
function participantsOf(e: any, props: string[] | undefined): string | null {
  if (!props) return null;
  for (const p of props) {
    const ids = itemIds(e, p);
    if (ids.length) return JSON.stringify(ids);
  }
  return null;
}

// First quantity claim as an integer (Wikidata amounts are signed decimal strings: "+50000000").
function firstQuantity(e: any, prop: string): number | null {
  const v = (e.claims?.[prop] ?? [])[0]?.mainsnak?.datavalue?.value;
  if (!v || typeof v.amount !== 'string') return null;
  const n = Number(v.amount);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// English aliases, capped, for places.aliases.
function aliasesOf(e: any): string | null {
  const list = (e.aliases?.en ?? []).map((a: any) => a?.value).filter((s: any) => typeof s === 'string').slice(0, MAX_ALIASES);
  return list.length ? JSON.stringify(list) : null;
}

type Precision = 'day' | 'month' | 'year' | 'decade' | 'century';
interface ParsedDate { iso: string; precision: Precision; year: number; }

// One Wikidata time value -> ISO YYYY-MM-DD (month/day padded to 01 below the
// precision) + precision. BCE returns null: outside the window, and the ISO form
// would need a sign that nothing downstream sorts correctly.
function parseTimeValue(dv: any): ParsedDate | null {
  if (!dv || typeof dv.time !== 'string') return null;
  const m = dv.time.match(/^([+-])(\d+)-(\d{2})-(\d{2})/);
  if (!m) return null;
  const year = (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10);
  if (year < 1) return null;
  const month = parseInt(m[3], 10) || 1;
  const day = parseInt(m[4], 10) || 1;
  const p: number = dv.precision ?? 11;
  const precision: Precision = p >= 11 ? 'day' : p === 10 ? 'month' : p === 9 ? 'year' : p === 8 ? 'decade' : 'century';
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return { iso: `${pad(year, 4)}-${pad(month)}-${pad(day)}`, precision, year };
}

// First usable value among the given properties (first claim of each, in order).
function parseTimeClaim(e: any, props: string[]): ParsedDate | null {
  for (const prop of props) {
    const d = parseTimeValue((e.claims?.[prop] ?? [])[0]?.mainsnak?.datavalue?.value);
    if (d) return d;
  }
  return null;
}

// P582 end time as ISO, or null when the event is a point, the end precedes the
// start (a data error) or the span is implausibly long for one event.
function endOf(e: any, start: ParsedDate): string | null {
  const end = parseTimeValue((e.claims?.P582 ?? [])[0]?.mainsnak?.datavalue?.value);
  if (!end || end.iso < start.iso) return null;
  if (end.year - start.year > MAX_SPAN_YEARS) return null;
  return end.iso;
}

const WIKI_BASE = 'https://en.wikipedia.org/wiki/';
const ENTITY_BASE = 'http://www.wikidata.org/entity/';
function sourceUrl(e: any): string {
  const title = e.sitelinks?.enwiki?.title;
  if (title) return WIKI_BASE + encodeURIComponent(String(title).split(' ').join('_'));
  return ENTITY_BASE + e.id;
}

// ===================== PASS 1: coords + subclass edges =====================
function runCoordsPass(): Promise<number> {
  console.log('Pass 1: indexing Earth coordinates (P625) + subclass edges (P279)...');
  db.exec('DELETE FROM _coords; DELETE FROM _subclass;');
  const insCoord = db.prepare('INSERT OR IGNORE INTO _coords(qid, lat, lng) VALUES(?, ?, ?)');
  const insSub = db.prepare('INSERT INTO _subclass(child, parent) VALUES(?, ?)');
  let batch = 0;
  db.exec('BEGIN');
  const flush = () => { if (++batch % 50000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); } };
  return streamDump((e) => {
    const coord = firstCoordinate(e);
    if (coord) { insCoord.run(e.id, coord.lat, coord.lng); flush(); }
    for (const c of (e.claims?.P279 ?? [])) {
      const parent = c?.mainsnak?.datavalue?.value?.id;
      if (parent) { insSub.run(e.id, parent); flush(); }
    }
  }).then((n) => {
    db.exec('COMMIT');
    const coords = (db.prepare('SELECT COUNT(*) AS c FROM _coords').get() as any).c;
    console.log(`Pass 1 done: ${n.toLocaleString()} lines, ${coords.toLocaleString()} geo-entities indexed.`);
    return n;
  });
}

// ---------- closure: expand root types into descendant type sets ----------
// Priority order = definition order, then roots order; first assignment wins.
function closureIndex<V, T>(groups: Array<{ value: V; roots: string[] }>, make: (value: V, root: string) => T): Map<string, T> {
  const map = new Map<string, T>();
  const closure = db.prepare(`
    WITH RECURSIVE d(q) AS (
      SELECT @root
      UNION
      SELECT s.child FROM _subclass s JOIN d ON s.parent = d.q
    )
    SELECT q FROM d
  `);
  for (const g of groups) {
    for (const root of g.roots) {
      for (const row of closure.all({ root }) as Array<{ q: string }>) {
        if (!map.has(row.q)) map.set(row.q, make(g.value, root));
      }
    }
  }
  return map;
}

interface TypeHit { category: string; root: string; }
function buildTypeIndex(): Map<string, TypeHit> {
  console.log('Closure: expanding category root types via P279* ...');
  // conflict before disaster before event, etc. The winning root is kept on the row as category_root.
  const map = closureIndex(CATEGORIES.map((def) => ({ value: def.category, roots: def.roots })), (category, root) => ({ category, root }));
  console.log(`Closure done: ${map.size.toLocaleString()} type QIDs mapped to categories.`);
  return map;
}

type PlaceLevel = 'country' | 'admin1' | 'county';
function buildPlaceIndex(): Map<string, PlaceLevel> {
  const map = closureIndex(PLACE_LEVELS.map((p) => ({ value: p.level, roots: p.roots })), (level) => level);
  console.log(`Closure done: ${map.size.toLocaleString()} type QIDs mapped to place levels.`);
  return map;
}

// ===================== PASS 2: extract events =====================
function runEventsPass(typeIndex: Map<string, TypeHit>, placeIndex: Map<string, PlaceLevel>): Promise<number> {
  console.log('Pass 2: extracting events with date precision (+ harvesting countries / admin divisions into places)...');
  const catByName = new Map(CATEGORIES.map((c) => [c.category, c]));
  const getCoord = db.prepare('SELECT lat, lng FROM _coords WHERE qid = ?');
  const insPlace = db.prepare(`
    INSERT OR IGNORE INTO places (id, name, level, parent_id, lat, lng, aliases)
    VALUES (@id, @name, @level, @parent_id, @lat, @lng, @aliases)
  `);
  let placesKept = 0;

  interface Placed { lat: number; lng: number; source: string; }
  const ownCoord = (e: any): Placed | null => {
    const c = firstCoordinate(e);
    return c ? { lat: c.lat, lng: c.lng, source: 'P625' } : null;
  };
  // Coordinate of a referenced entity, via the Earth-only P625 index from pass 1.
  const refCoord = (qid: string | null, source: string): Placed | null => {
    if (!qid) return null;
    const co = getCoord.get(qid) as { lat: number; lng: number } | undefined;
    return co ? { lat: co.lat, lng: co.lng, source } : null;
  };
  const placeCoord = (e: any): Placed | null => {
    for (const prop of PLACE_PROPS) {
      const hit = refCoord(firstItemId(e, prop), prop);
      if (hit) return hit;
    }
    return null;
  };
  const resolveCoord = (e: any, def: CategoryDef, sl: number): Placed | null => {
    const mode = def.coordMode ?? 'p625';
    if (mode === 'p625') return ownCoord(e);
    const fallback = sl >= (def.fallbackFloor ?? def.floor) ? placeCoord(e) : null;
    if (mode === 'place_first') return fallback ?? ownCoord(e);
    return ownCoord(e) ?? fallback;
  };

  const insEvent = db.prepare(`
    INSERT OR IGNORE INTO events
      (id, title, blurb, date_start, date_end, date_precision, lat, lng, coord_source, place_id, country_id,
       category, category_root, wikidata_types, sitelinks, notability, participants, deaths, source_url, source_ids, ingest_version)
    VALUES
      (@id, @title, @blurb, @date_start, @date_end, @date_precision, @lat, @lng, @coord_source, @place_id, @country_id,
       @category, @category_root, @wikidata_types, @sitelinks, @notability, @participants, @deaths, @source_url, @source_ids, @ingest_version)
  `);

  let kept = 0;
  const bySource: Record<string, number> = {};
  let batch = 0;
  db.exec('BEGIN');
  const flush = () => { if (++batch % 20000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); } };

  const inWindow = (year: number) => year >= START_YEAR && year <= END_YEAR;
  const notabilityOf = (sl: number) => Math.round(Math.min(1, sl / 100) * 1000) / 1000;

  const add = (row: Record<string, unknown>) => {
    insEvent.run(row);
    kept++;
    const s = String(row.coord_source);
    bySource[s] = (bySource[s] ?? 0) + 1;
    flush();
  };

  return streamDump((e) => {
    const types = instanceIds(e);
    if (types.length === 0) return;
    const sl = sitelinkCount(e);
    const title = e.labels?.en?.value;
    if (!title) return;
    const blurb = e.descriptions?.en?.value ?? null;
    const country_id = firstItemId(e, 'P17');
    const common = {
      title,
      blurb,
      wikidata_types: JSON.stringify(types.slice(0, MAX_TYPES)),
      sitelinks: sl,
      notability: notabilityOf(sl),
      country_id,
      participants: null as string | null,
      deaths: null as number | null,
      source_url: sourceUrl(e),
      source_ids: JSON.stringify({ wikidata: e.id }),
      ingest_version: INGEST_VERSION,
    };

    // --- places: countries / first- and second-level divisions (no date or floor test) ---
    // Not a return: the same entity is usually ALSO a founding event below.
    {
      let level: PlaceLevel | undefined;
      for (const t of types) { level = placeIndex.get(t); if (level) break; }
      if (level) {
        const co = firstCoordinate(e);
        const parentRaw = firstItemId(e, 'P131') ?? country_id;
        const parent_id = parentRaw && parentRaw !== e.id ? parentRaw : null; // countries list themselves as P17
        try {
          const r = insPlace.run({ id: e.id, name: title, level, parent_id, lat: co?.lat ?? null, lng: co?.lng ?? null, aliases: aliasesOf(e) });
          if (r.changes) { placesKept++; flush(); }
        } catch (err) {
          // A bad place row must never abort an 8-hour run; the events side does not depend on it.
          console.warn(`  places: skipped ${e.id} (${title}): ${(err as Error).message}`);
        }
      }
    }

    // --- humans: births + deaths (coords resolved from birth/death place) ---
    if (types.includes('Q5')) {
      if (sl < HUMAN_FLOOR) return;
      const birth = parseTimeClaim(e, ['P569']);
      if (birth && inWindow(birth.year)) {
        const place = firstItemId(e, 'P19');
        const co = refCoord(place, 'P19');
        if (co) add({ ...common, id: `${e.id}#birth`, date_start: birth.iso, date_end: null, date_precision: birth.precision, lat: co.lat, lng: co.lng, coord_source: co.source, place_id: place, category: 'birth', category_root: 'Q5' });
      }
      const death = parseTimeClaim(e, ['P570']);
      if (death && inWindow(death.year)) {
        const place = firstItemId(e, 'P20');
        const co = refCoord(place, 'P20');
        if (co) add({ ...common, id: `${e.id}#death`, date_start: death.iso, date_end: null, date_precision: death.precision, lat: co.lat, lng: co.lng, coord_source: co.source, place_id: place, category: 'death', category_root: 'Q5' });
      }
      return;
    }

    // --- typed events (conflict/disaster/election/treaty/founding/discovery/milestone/event) ---
    let hit: TypeHit | undefined;
    for (const t of types) { hit = typeIndex.get(t); if (hit) break; }
    if (!hit) return;
    const def = catByName.get(hit.category)!;
    if (sl < def.floor) return;

    const date = parseTimeClaim(e, def.dateProps);
    if (!date || !inWindow(date.year)) return;
    const coord = resolveCoord(e, def, sl);
    if (!coord) return; // event must be placeable

    add({
      ...common,
      id: e.id,
      date_start: date.iso,
      date_end: RANGED.has(def.category) ? endOf(e, date) : null,
      date_precision: date.precision,
      lat: coord.lat,
      lng: coord.lng,
      coord_source: coord.source,
      place_id: firstItemId(e, 'P131') ?? country_id, // containing division, else the country
      category: def.category,
      category_root: hit.root,
      participants: participantsOf(e, PARTICIPANT_PROPS[def.category]),
      deaths: firstQuantity(e, 'P1120'),
    });
  }).then((n) => {
    db.exec('COMMIT');
    console.log(`Pass 2 done: scanned ${n.toLocaleString()} lines, inserted ${kept.toLocaleString()} events, ${placesKept.toLocaleString()} places.`);
    console.log('  placed by: ' + Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v.toLocaleString()}`).join('  '));
    return n;
  });
}

// ===================== main =====================
(async () => {
  const t0 = Date.now();
  if (PASS === 'all' || PASS === 'coords') await runCoordsPass();
  const typeIndex = buildTypeIndex();
  const placeIndex = buildPlaceIndex();
  if (PASS === 'all' || PASS === 'events') await runEventsPass(typeIndex, placeIndex);

  // Rebuild FTS + stamp provenance.
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
  const setMeta = db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  setMeta.run('dataset_version', INGEST_VERSION);
  setMeta.run('window', `${START_YEAR}-${END_YEAR}`);
  setMeta.run('ingest_dump', basename(DUMP as string));
  setMeta.run('ingest_finished', new Date().toISOString());
  if (MAX_LINES) setMeta.run('ingest_max_lines', String(MAX_LINES));

  const total = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c;
  console.log(`\nTotal events in DB: ${total.toLocaleString()}  (window ${START_YEAR}-${END_YEAR})`);
  console.table(db.prepare(`
    SELECT category,
           COUNT(*)                                            AS rows_,
           SUM(date_end IS NOT NULL)                           AS ranged,
           SUM(coord_source IN ('P276', 'P17', 'P495'))        AS fallback_coord,
           SUM(participants IS NOT NULL)                       AS with_participants,
           SUM(place_id IS NOT NULL)                           AS with_place,
           ROUND(AVG(sitelinks), 1)                            AS avg_sitelinks
    FROM events
    GROUP BY category
    ORDER BY rows_ DESC
  `).all());
  console.table(db.prepare(`
    SELECT level, COUNT(*) AS rows_, SUM(lat IS NOT NULL) AS with_coord, SUM(parent_id IS NOT NULL) AS with_parent
    FROM places GROUP BY level ORDER BY rows_ DESC
  `).all());
  console.log(`Elapsed: ${Math.round((Date.now() - t0) / 1000)}s. Next: npm run post-ingest   (seed, prune, rescope, score, expand:participants, score, titles)`);
  db.close();
})().catch((err) => { console.error(err); process.exit(1); });
