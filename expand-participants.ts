import Database from 'better-sqlite3';

// ===================== Participant expansion (post-ingest, no re-ingest) =====================
// A war is placed at ONE point: where Wikidata says it happened (or, failing that,
// the centroid of the first country listed). World War II sits in Europe. The
// engine then asks "is this point within reach_km of the life?" -- and for an
// Ohio Valley life the answer is no, even though the United States fought in it
// for four years. Users saw the gap as "the world wars are missing".
//
// The universal tier fixes the handful of events every life should see. This
// script fixes the long tail underneath it: any conflict / treaty / disaster /
// event with a participant list (events.participants, from P710 / P1891, kept by
// dump-v0.6) gets ONE extra row per participating COUNTRY, placed at that
// country's centroid (places table, level 'country'), scope 'national'.
//
//   'World War II'  ->  'World War II — United States'  (id Q362#Q30, lat/lng of the US)
//                       'World War II — Canada'         (Q362#Q16)
//                       ...
//
// score.ts keeps these rows 'national' (coord_source = 'P710' is the marker) and
// gives them a reach of ~1,050-1,950 km from the centroid, which covers the
// contiguous US from Kansas. prune.ts / prune-series.ts never delete them.
//
// Rules that keep this from becoming a row pile:
//   - the parent needs at least --min sitelinks (default 40): the Seven Years'
//     War qualifies, a border skirmish with 6 articles does not
//   - a participant that is not a COUNTRY in places (a general, an army, a party)
//     is skipped; a country whose centroid is already inside the parent's own
//     reach is skipped (no 'Battle of Gettysburg — United States')
//   - universal rows are skipped: they already reach everyone
//   - the parent's own participants column is what makes it re-runnable: rows
//     are INSERT OR IGNORE on a deterministic id, and --reset removes them all
//
//   npm run expand:participants -- --dry        report only
//   npm run expand:participants                 apply (idempotent)
//   npm run expand:participants -- --min=60     stricter parent floor
//   npm run expand:participants -- --reset      delete every expanded row, then stop
//
// Run AFTER the first `npm run score` (needs the parents' reach_km) and BEFORE the
// second (which scores the new rows). `npm run post-ingest` sequences this.

const args = process.argv.slice(2);
const hasFlag = (n: string) => args.includes(`--${n}`);
const flagValue = (n: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};
const DRY = hasFlag('dry');
const RESET = hasFlag('reset');
const MIN_SITELINKS = Math.max(1, parseInt(flagValue('min') ?? '40', 10) || 40);
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';
const EXPANDED_VERSION_SUFFIX = '+participants-v0.1';
const CATEGORIES = ['conflict', 'treaty', 'disaster', 'event'];
const MAX_COUNTRIES_PER_PARENT = 80; // safety valve against pathological lists; the world wars are universal and never reach this code

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

const cols = new Set((db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((c) => c.name));
for (const c of ['participants', 'country_id', 'reach_km', 'coord_source']) {
  if (!cols.has(c)) {
    console.error(`${DB_PATH} has no events.${c}: this needs a dump-v0.6 ingest (participants) that has been scored once (reach_km).`);
    process.exit(1);
  }
}

if (RESET) {
  const info = db.prepare(`DELETE FROM events WHERE coord_source = 'P710'`).run();
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
  console.log(`--reset: removed ${info.changes.toLocaleString()} participant-expanded rows.`);
  db.close();
  process.exit(0);
}

interface Parent {
  id: string; title: string; display_title: string | null; blurb: string | null; date_start: string; date_end: string | null; date_precision: string | null;
  lat: number | null; lng: number | null; reach_km: number | null; scope: string | null; category: string; category_root: string | null;
  notability: number | null; sitelinks: number | null; participants: string; source_url: string | null; source_ids: string | null;
  ingest_version: string; wikidata_types: string | null; country_id: string | null;
}
interface Country { id: string; name: string; lat: number | null; lng: number | null; }

const parents = db.prepare(`
  SELECT id, title, display_title, blurb, date_start, date_end, date_precision, lat, lng, reach_km, scope, category, category_root,
         notability, sitelinks, participants, source_url, source_ids, ingest_version, wikidata_types, country_id
  FROM events
  WHERE participants IS NOT NULL
    AND category IN (${CATEGORIES.map((c) => `'${c}'`).join(', ')})
    AND scope IS NOT 'universal'
    AND coord_source IS NOT 'P710'
    AND ingest_version NOT LIKE 'seed-%'
    AND COALESCE(sitelinks, 0) >= @min
  ORDER BY sitelinks DESC
`).all({ min: MIN_SITELINKS }) as Parent[];

if (parents.some((p) => p.reach_km === null)) {
  console.error('Some parents have no reach_km yet. Run `npm run score` first, then this script, then `npm run score` again.');
  process.exit(1);
}

const getCountry = db.prepare(`SELECT id, name, lat, lng FROM places WHERE id = ? AND level = 'country'`);
const ins = db.prepare(`
  INSERT OR IGNORE INTO events
    (id, title, display_title, blurb, date_start, date_end, date_precision, lat, lng, place_id, country_id, scope, category, category_root,
     notability, sitelinks, participants, source_url, source_ids, ingest_version, coord_source, wikidata_types)
  VALUES
    (@id, @title, @display_title, @blurb, @date_start, @date_end, @date_precision, @lat, @lng, @place_id, @country_id, 'national', @category, @category_root,
     @notability, @sitelinks, NULL, @source_url, @source_ids, @ingest_version, 'P710', @wikidata_types)
`);

const EARTH_R = 6371;
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

let considered = 0;
let parentsExpanded = 0;
let inserted = 0;
let notCountry = 0;
let alreadyInReach = 0;
let noCentroid = 0;
let tooMany = 0;
const samples: string[] = [];

const run = db.transaction(() => {
  for (const p of parents) {
    let ids: string[];
    try { ids = JSON.parse(p.participants); } catch { continue; }
    if (!Array.isArray(ids) || ids.length === 0) continue;
    const countries: Country[] = [];
    for (const qid of ids) {
      considered++;
      const c = getCountry.get(qid) as Country | undefined;
      if (!c) { notCountry++; continue; }
      if (c.lat === null || c.lng === null) { noCentroid++; continue; }
      if (p.lat !== null && p.lng !== null && haversineKm(p.lat, p.lng, c.lat, c.lng) <= (p.reach_km ?? 0)) { alreadyInReach++; continue; }
      countries.push(c);
    }
    if (countries.length === 0) continue;
    if (countries.length > MAX_COUNTRIES_PER_PARENT) { tooMany++; continue; }
    parentsExpanded++;
    const baseTitle = p.display_title ?? p.title;
    for (const c of countries) {
      const res = ins.run({
        id: `${p.id}#${c.id}`,
        title: p.title,
        display_title: `${baseTitle} — ${c.name}`,
        blurb: p.blurb,
        date_start: p.date_start,
        date_end: p.date_end,
        date_precision: p.date_precision,
        lat: c.lat,
        lng: c.lng,
        place_id: c.id,
        country_id: c.id,
        category: p.category,
        category_root: p.category_root,
        notability: p.notability,
        sitelinks: p.sitelinks,
        source_url: p.source_url,
        source_ids: JSON.stringify({ ...(safeJson(p.source_ids) ?? {}), parent: p.id, participant: c.id }),
        ingest_version: p.ingest_version + EXPANDED_VERSION_SUFFIX,
        wikidata_types: p.wikidata_types,
      });
      if (DRY || res.changes) inserted++;
      if (samples.length < 12) samples.push(`${baseTitle} — ${c.name}  (${String(p.date_start).slice(0, 4)}, parent ${p.id}, ${p.sitelinks} sitelinks)`);
    }
  }
  if (DRY) throw new Error('__dry__');
});

try { run(); } catch (e) { if (!(e instanceof Error && e.message === '__dry__')) throw e; }

function safeJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

console.log(`Parents with a participant list (>= ${MIN_SITELINKS} sitelinks, not universal): ${parents.length.toLocaleString()}`);
console.log(`  participant ids considered: ${considered.toLocaleString()}  -> not a country in places: ${notCountry.toLocaleString()}, no centroid: ${noCentroid.toLocaleString()}, already inside parent reach: ${alreadyInReach.toLocaleString()}`);
console.log(`  parents skipped for > ${MAX_COUNTRIES_PER_PARENT} countries (world-war scale; universal tier territory): ${tooMany.toLocaleString()}`);
console.log(`  parents expanded: ${parentsExpanded.toLocaleString()}  ->  national rows ${DRY ? 'that would be' : ''} inserted: ${inserted.toLocaleString()}`);
console.log('\nSamples:');
for (const s of samples) console.log(`  ${s}`);

if (DRY) {
  console.log('\nDRY RUN. Nothing written.');
} else {
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
  db.prepare(`INSERT INTO meta(key, value) VALUES('last_participant_expansion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(`${inserted} rows from ${parentsExpanded} parents (min ${MIN_SITELINKS} sitelinks) at ${new Date().toISOString()}`);
  console.log('\nNext: npm run score   (scores the new rows: scope stays national, significance + reach are computed)');
}
db.close();
