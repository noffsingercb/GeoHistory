import Database from 'better-sqlite3';
import { isInstitution } from './classify';

// ===================== Founding sub-type classifier =====================
// Before v0.6, `ingest-dump.ts` used an item's P31 types to pick a category and
// then discarded them. So "Las Vegas was incorporated" and "Arizona became a state"
// arrived in the events table as indistinguishable `founding` rows, and score.ts's
// notability ladder gave BOTH a national scope -> a 1,950 km reach. That is why a
// Pueblo timeline ranked the founding of Las Vegas, 961 km away, as national context.
//
// dump-v0.6 keeps the P31 list on every row (events.wikidata_types), so the kind
// is now read from STRUCTURE first and from the blurb only as a fallback:
//   Q515 city / Q1549591 big city           -> city         -> local (score.ts)
//   Q3957 town / Q532 village               -> settlement   -> local
//   Q10864048 first-level admin division    -> subnational  -> national
//   Q6256 / Q3624078 / Q3024240 country     -> country      -> national / global
//   blurb says university / hospital / ...  -> institution  -> regional / local
// Rows from a v0.5 file (wikidata_types NULL) still go through the blurb rules:
//   "city in Nevada, United States"        -> settlement (v0.5 could not tell a city from a town)
//   "state of the United States"           -> subnational
//   "sovereign state in South America"     -> country
//   "university in Toronto, Ontario"       -> institution
//
// founding_kind drives RANK as well as scope: core.ts resolves its per-row
// weight through DEFAULT_CONFIG.foundingKindWeights (settlement 0.35, institution
// 0.5, subnational 0.9, country 0.9; city falls back to settlement's weight until
// core.ts learns the kind) before falling back to categoryWeights. A row left
// unclassified keeps both the old notability-ladder scope and the flat 0.7 weight.
//
// NOTE: institution rows are ALSO handled directly in score.ts, because the ingest
// files institutions inconsistently -- York University and DeVry University both
// landed in category 'event', where this script never sees them. The shared test
// lives in classify.ts so both paths agree.
//
// This script writes ONLY events.founding_kind. score.ts remains the sole owner of
// scope and reach, so the pipeline is:
//
//   npm run rescope:foundings          # classify (this script)
//   npm run score                      # derive scope from founding_kind, re-materialize reach
//
// Flags:
//   --dry     classify and report without writing anything
//   --reset   clear founding_kind first (use when re-running after editing patterns)
//   --limit=N sample only N rows (quick pattern iteration)

const argv = process.argv.slice(2).map((a) => a.toLowerCase());
const DRY = argv.includes('--dry');
const RESET = argv.includes('--reset');
const LIMIT = (() => {
  const a = argv.find((x) => x.startsWith('--limit='));
  const n = a ? parseInt(a.split('=')[1], 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Idempotent migration so this runs against an existing DB with no rebuild.
try { db.exec('ALTER TABLE events ADD COLUMN founding_kind TEXT;'); } catch { /* column already exists */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_events_founding_kind ON events(founding_kind);');
const hasTypes = (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).some((c) => c.name === 'wikidata_types');

type FoundingKind = 'settlement' | 'city' | 'subnational' | 'country' | 'institution';

// P31 -> kind. Mirrors the founding roots in ingest-dump.ts. Only DIRECT types are
// matched here (the closure lives in the ingest). Q1093829 is the concrete class
// used by United States city rows, including Q1810731.
//
// This structural safety net is preferred over report-only triage: the class and
// the phrase 'county seat of' unambiguously describe populated places.
const POPULATED_PLACE_SAFETY_NET_TYPES = new Set(['Q1093829']);

const TYPE_KIND: Record<string, FoundingKind> = {
  Q515: 'city',          // city
  Q1549591: 'city',      // big city
  Q1637706: 'city',      // city with millions of inhabitants
  Q174844: 'city',       // megacity
  Q5119: 'city',         // capital
  Q1093829: 'city',      // city of the United States
  Q3957: 'settlement',   // town
  Q532: 'settlement',    // village
  Q486972: 'settlement', // human settlement
  Q3327873: 'settlement',// unincorporated community
  Q498162: 'settlement', // census-designated place
  Q10864048: 'subnational', // first-level administrative division
  Q35657: 'subnational',    // US state
  Q1352230: 'subnational',  // US territory
  Q6256: 'country',      // country
  Q3624078: 'country',   // sovereign state
  Q3024240: 'country',   // historical country
  Q1763527: 'country',   // constituent country
};

const COUNTY_SEAT_SETTLEMENT = /\bcounty seat of\b/;

// An explicit settlement noun is decisive even when the description also names the
// containing state or country. 'County seat of' describes the populated place
// serving as the seat, not the founding of the county itself.
const SETTLEMENT: RegExp[] = [
  /\b(city|cities|town|township|village|hamlet|borough|municipality|commune|settlement|suburb|neighborhood|neighbourhood|metropolis|locality)\b/,
  /\burban (area|district|settlement)\b/,
  /\bunincorporated (area|community)\b/,
  /\bcensus-designated place\b/,
  /\bcapital (city )?of\b/,
  /\bhuman settlement\b/,
  /\bport (city|town)\b/,
  COUNTY_SEAT_SETTLEMENT,
];

// Subnational administrative divisions. Checked BEFORE the generic country rules so
// "republic in Russia" (Tatarstan) is not mistaken for a sovereign state.
const SUBNATIONAL: RegExp[] = [
  /\bstate (of|in)\b/,
  /\bfederal state\b/,
  /\b(republic|oblast|krai|okrug) (in|of) (russia|the russian federation|the soviet union|the ussr)\b/,
  /\bprovince\b/,
  /\bprefecture\b/,
  /\bregion (of|in)\b/,
  /\bcounty\b/,
  /\bparish\b/,
  /\bdistrict\b/,
  /\bdepartment (of|in)\b/,
  /\bcanton\b/,
  /\boblast\b/,
  /\bkrai\b/,
  /\bokrug\b/,
  /\bvoivodeship\b/,
  /\bgovernorate\b/,
  /\bautonomous (community|region|okrug|oblast|republic)\b/,
  /\bterritory (of|in)\b/,
  /\badministrative (division|region|unit|territorial entity)\b/,
];

const COUNTRY: RegExp[] = [
  /\bcountry\b/,
  /\bnation\b/,
  /\b(federal |islamic |people's |socialist |democratic )?republic (in|of)\b/,
  /\bkingdom (in|of)\b/,
  /\bempire\b/,
  /\bcaliphate\b/,
  /\bconfederation\b/,
];

/**
 * Blurb rules. Order is load-bearing:
 *   1. institutions win outright -- "university in the city of Toronto" is a
 *      university, not a settlement, and the settlement rule would otherwise
 *      claim it on the word "city",
 *   2. settlement nouns next,
 *   3. "sovereign state" beats the generic "state of/in" subnational rule,
 *   4. subnational divisions beat the generic country rules,
 *   5. remaining country wording.
 * Anything unmatched returns null and keeps the old notability-ladder behavior.
 */
function classifyBlurb(blurb: string | null): FoundingKind | null {
  if (!blurb) return null;
  const b = blurb.toLowerCase();
  if (isInstitution(blurb)) return 'institution';
  if (SETTLEMENT.some((re) => re.test(b))) return 'settlement';
  if (/\bsovereign state\b/.test(b) || /\bindependent (country|state|nation)\b/.test(b)) return 'country';
  if (SUBNATIONAL.some((re) => re.test(b))) return 'subnational';
  if (COUNTRY.some((re) => re.test(b))) return 'country';
  return null;
}

/**
 * Structure first. Institutions still win (a "university town" item typed Q3957 is
 * a town; but a row whose blurb says "university" and whose P31 is Q515 is a data
 * error we resolve in favour of the blurb, as before). Among the place types the
 * MOST SPECIFIC wins: an item typed both 'city' and 'first-level admin division'
 * (Berlin, Mexico City) is a city for the purposes of "how far did its founding
 * travel", and the founding of a city-state typed country + city stays a country.
 */
function classify(types: string[] | null, blurb: string | null): { kind: FoundingKind | null; via: 'types' | 'blurb' | 'none' } {
  if (isInstitution(blurb)) return { kind: 'institution', via: 'blurb' };
  if (types && types.length) {
    const kinds = new Set(types.map((t) => TYPE_KIND[t]).filter(Boolean) as FoundingKind[]);
    if (kinds.has('country')) return { kind: 'country', via: 'types' };
    if (kinds.has('city')) return { kind: 'city', via: 'types' };
    if (kinds.has('settlement')) return { kind: 'settlement', via: 'types' };
    if (kinds.has('subnational')) return { kind: 'subnational', via: 'types' };
  }
  const kind = classifyBlurb(blurb);
  return { kind, via: kind ? 'blurb' : 'none' };
}

// Mirrors FOUNDING_KIND_SCOPE in score.ts and foundingKindWeights in core.ts --
// reporting only, kept in sync by hand.
const SCOPE_LABEL: Record<string, string> = {
  settlement: 'local (50-60 km), rank weight 0.35',
  city: 'local (50-60 km), rank weight 0.35 until core.ts adds a city weight',
  institution: 'regional (210-300 km) or local, rank weight 0.5',
  subnational: 'national (1,050-1,950 km), rank weight 0.9',
  country: 'national / global (by notability), rank weight 0.9',
  unclassified: 'unchanged (notability ladder), rank weight 0.7',
};

// ===================== Run =====================

if (RESET && !DRY) {
  const cleared = db.prepare(`UPDATE events SET founding_kind = NULL WHERE category = 'founding'`).run();
  console.log(`--reset: cleared founding_kind on ${cleared.changes.toLocaleString()} rows.`);
}

interface Row { id: string; title: string; blurb: string | null; notability: number | null; wikidata_types: string | null; }

const rows = db.prepare(`
  SELECT id, title, blurb, notability, ${hasTypes ? 'wikidata_types' : 'NULL AS wikidata_types'}
  FROM events
  WHERE category = 'founding'
  ORDER BY notability DESC
  ${LIMIT ? 'LIMIT ' + LIMIT : ''}
`).all() as Row[];

const tally: Record<string, number> = { settlement: 0, city: 0, institution: 0, subnational: 0, country: 0, unclassified: 0 };
const via: Record<string, number> = { types: 0, blurb: 0, none: 0 };
const decided: Array<{ id: string; kind: FoundingKind }> = [];
const unclassified: Row[] = [];
let populatedPlaceSafetyNet = 0;

for (const r of rows) {
  let types: string[] | null = null;
  if (r.wikidata_types) { try { types = JSON.parse(r.wikidata_types); } catch { types = null; } }
  const res = classify(types, r.blurb);
  const matchedPopulatedPlaceSafetyNet =
    (types?.some((type) => POPULATED_PLACE_SAFETY_NET_TYPES.has(type)) ?? false) ||
    COUNTY_SEAT_SETTLEMENT.test((r.blurb ?? '').toLowerCase());
  via[res.via]++;
  if (res.kind) {
    tally[res.kind]++;
    decided.push({ id: r.id, kind: res.kind });
    if (matchedPopulatedPlaceSafetyNet) populatedPlaceSafetyNet++;
  } else {
    tally.unclassified++;
    unclassified.push(r);
  }
}

if (!DRY) {
  const upd = db.prepare(`UPDATE events SET founding_kind = @kind WHERE id = @id`);
  const tx = db.transaction((items: Array<{ id: string; kind: FoundingKind }>) => {
    for (const it of items) upd.run(it);
  });
  tx(decided);
}

// ---------- report ----------
console.log(`\nfounding rows examined: ${rows.length.toLocaleString()}${DRY ? '  (dry run, nothing written)' : ''}`);
console.log(`  decided from P31 types: ${via.types.toLocaleString()}   from blurb: ${via.blurb.toLocaleString()}   undecided: ${via.none.toLocaleString()}`);
console.log(`  populated-place safety net classified: ${populatedPlaceSafetyNet.toLocaleString()} (Q1093829 or 'county seat of').`);
console.table(
  Object.entries(tally).map(([kind, count]) => ({
    kind,
    count,
    share: rows.length ? `${((count / rows.length) * 100).toFixed(1)}%` : '-',
    scope: SCOPE_LABEL[kind] ?? '?',
  })),
);

// The unclassified rows that matter are the famous ones -- those are the entries
// that will keep surfacing in timelines with an inflated reach.
if (unclassified.length) {
  console.log(`\nTop unclassified by notability (extend TYPE_KIND or the patterns if these look systematic):`);
  console.table(unclassified.slice(0, 20).map((r) => ({
    notability: r.notability,
    title: r.title.slice(0, 40),
    types: (r.wikidata_types ?? '').slice(0, 40),
    blurb: (r.blurb ?? '(none)').slice(0, 60),
  })));
}

console.log(`\nNext: npm run score      # derives scope from founding_kind and re-materializes reach`);
if (DRY) console.log('(re-run without --dry to write founding_kind)');

db.close();
