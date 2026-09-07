import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

// ===================== Curated seed loader (non-scripted rows) =====================
// Merges hand-authored event rows (curated in Notion, exported to seed/*.json)
// into the SAME events table as the Wikidata dump ingest. Kept separate from the
// scripted ingest so these rows are reproducible, identifiable (ingest_version
// starts with "seed-"), and can be re-run or rolled back independently.
//
//   npm run seed     -> upsert all curated rows, then rebuild FTS
//   npm run score    -> (run afterwards) computes significance + reach; the scorer
//                       PRESERVES each seed row's authored scope.
//
// Idempotent: id = "seed:<slug of Seed ID, else title>"; the upsert refreshes
// mutable fields so editing the JSON and re-seeding applies the edits. Fails fast
// on id collisions.
//
// A note on ids: deriving the id from the title alone assumes titles are globally
// unique. That holds for the curated invention rows (each names a distinct thing)
// but NOT for timeline rows titled after a place -- "Hungary" or "Canada" legitimately
// recur across centuries. Such files must set an explicit "Seed ID" per row.
//
// ---- Universal tier (v0.6) ----
// seed/universal-v0.1.json holds the short list of events every life overlapping
// their dates should see, wherever it was lived: the Black Death, the World Wars,
// the 1918 flu, 9/11, COVID-19. Its rows carry Tier: "universal" and land in the
// table with scope = 'universal', which
//   - score.ts never overrides (significance is pinned to 1.0, reach to the globe),
//   - prune.ts / prune-series.ts never delete,
//   - core.ts draws for every overlapping segment with no distance test
//     (config.universalQuota, additive to maxPerSegment).
// Most universal rows name a Wikidata QID. When the dump ALREADY holds that row
// (Q362 = World War II), the seed does not add a second copy: it PROMOTES the dump
// row in place (scope, display title, curated blurb and dates), so the timeline
// never shows the same war twice. When the dump row is absent (the Industrial
// Revolution is a 'period' in Wikidata, never an event; or a slice-test file) the
// row is inserted as universal:<slug> instead. Either way the Wikidata id goes
// into source_ids so the two shapes stay traceable.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';
const SEED_VERSION = 'seed-inventions-v0.1';
const UNIVERSAL_VERSION = 'seed-universal-v0.1';
// Split into era-bucketed files to avoid single-write truncation on large pushes.
const FILES = [
  'inventions.json',
  'inventions-2-1873-1909.json',
  'inventions-3-1911-1948.json',
  'inventions-4-1950-1984.json',
  'inventions-5-1986-2020.json',
  // Wikipedia timeline + century pages, 1275 AD onward. Every row sets an
  // explicit "Seed ID" because these are titled after places, not events.
  'timeline-wikipedia-1-pre1700.json',
  'timeline-wikipedia-2-1700-1849.json',
  'timeline-wikipedia-3-1850-1919.json',
  'timeline-wikipedia-4-1920-1979.json',
  'timeline-wikipedia-5-1980-present.json',
  // Universal tier. Loaded LAST so a promote can find the dump row it targets
  // even when that row was itself touched by an earlier seed file.
  'universal-v0.1.json',
];

// Curated rows are stored in the exact shape exported from the Notion review
// table (display-name keys) so an export can be pasted in verbatim.
interface RawRow {
  Title: string;
  Blurb: string | null;
  'Date start': string;
  'Date end'?: string | null;            // ranged events (wars, pandemics); null / absent = a point
  Precision: 'day' | 'month' | 'year' | 'decade' | 'century';
  Category: string;
  Place?: string | null;
  Lat: number | null;
  Lng: number | null;
  Notability: number | null;
  'Scope (intended)': 'local' | 'regional' | 'national' | 'global' | 'universal';
  'Source URL': string | null;
  'Ingest version'?: string | null;
  // Optional stable identifier. When present it replaces the title as the basis
  // for the row id, which is what lets files with repeated titles load at all.
  // Changing it after a seed run creates a NEW row rather than updating the old one.
  'Seed ID'?: string | null;
  // Reader-facing phrasing when the title is a bare label ('Birth of Arthur C. Clarke').
  'Display title'?: string | null;
  // Universal-tier controls (see header). Tier 'universal' forces scope 'universal'.
  Tier?: 'universal' | null;
  // 'promote' (default when Wikidata is set): update the dump row with that QID in
  // place; fall back to an insert if it is absent. 'insert': always a separate row.
  Action?: 'insert' | 'promote' | null;
  Wikidata?: string | null;             // QID of the same event in Wikidata, e.g. Q362
  Review?: string | null;               // curator notes; ignored by the loader
  Note?: string | null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8')); // ensure tables exist
db.pragma('foreign_keys = OFF'); // schema.sql turns it back on; seed rows have no place_id

// Refuse to seed a file with no scripted rows. The Sept 6 slice test ran the whole
// post-ingest chain on a database the failed ingest had never written to, and the
// seed rows alone looked like a (tiny) dataset. Override only for a deliberate test.
{
  const dumpRows = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ingest_version IS NULL OR ingest_version NOT LIKE 'seed-%'`).get() as any).c as number;
  if (dumpRows === 0 && !process.argv.includes('--allow-empty')) {
    console.error(`\n!! ${DB_PATH} holds no dump rows (0 events outside seed-*): the ingest did not run or failed.`);
    console.error('!! Run npm run ingest:check, then npm run ingest:dump. To seed an empty file on purpose: npm run seed -- --allow-empty\n');
    process.exit(1);
  }
}

const upsert = db.prepare(`
  INSERT INTO events
    (id, title, display_title, blurb, date_start, date_end, date_precision, lat, lng, scope, category, notability, source_url, source_ids, ingest_version)
  VALUES
    (@id, @title, @display_title, @blurb, @date_start, @date_end, @date_precision, @lat, @lng, @scope, @category, @notability, @source_url, @source_ids, @ingest_version)
  ON CONFLICT(id) DO UPDATE SET
    title          = excluded.title,
    display_title  = excluded.display_title,
    blurb          = excluded.blurb,
    date_start     = excluded.date_start,
    date_end       = excluded.date_end,
    date_precision = excluded.date_precision,
    lat            = excluded.lat,
    lng            = excluded.lng,
    scope          = excluded.scope,
    category       = excluded.category,
    notability     = excluded.notability,
    source_url     = excluded.source_url,
    source_ids     = excluded.source_ids,
    ingest_version = excluded.ingest_version
`);

// Promotion of an existing dump row to the universal tier. Curated fields win
// where given; the dump's coordinates, types, participants and sitelinks stay.
const findDumpRow = db.prepare(`SELECT id, title, scope FROM events WHERE id = ? AND ingest_version NOT LIKE 'seed-%'`);
const promote = db.prepare(`
  UPDATE events SET
    scope          = 'universal',
    display_title  = COALESCE(@display_title, display_title),
    blurb          = COALESCE(@blurb, blurb),
    date_start     = COALESCE(@date_start, date_start),
    date_end       = COALESCE(@date_end, date_end),
    date_precision = COALESCE(@date_precision, date_precision),
    notability     = MAX(COALESCE(notability, 0), COALESCE(@notability, 0)),
    source_ids     = json_patch(COALESCE(source_ids, '{}'), @source_patch)
  WHERE id = @id
`);
// Rows inserted as universal:<slug> on an earlier run that can now be promoted
// instead (the dump row has since arrived) must go, or the war shows twice.
const dropStale = db.prepare(`DELETE FROM events WHERE id = ? AND ingest_version = ?`);

const seenIds = new Map<string, string>(); // id -> "file: title" of first claimant
let total = 0;
let promoted = 0;
let fellBack = 0;

function loadFile(name: string): void {
  const rows = JSON.parse(readFileSync(join(__dirname, 'seed', name), 'utf8')) as RawRow[];
  const isUniversalFile = name.startsWith('universal-');
  const tx = db.transaction((items: RawRow[]) => {
    for (const r of items) {
      const title = (r.Title ?? '').trim();
      if (!title) continue;

      const universal = r.Tier === 'universal' || r['Scope (intended)'] === 'universal';
      // Prefer the curator-authored Seed ID; fall back to the title so existing
      // seed files keep the exact ids they were first loaded with. Universal rows
      // get their own prefix so nothing that filters on 'seed:' can confuse the two.
      const explicit = (r['Seed ID'] ?? '').trim().replace(/^(seed|universal):/, '');
      const id = `${universal ? 'universal' : 'seed'}:${slugify(explicit || title)}`;

      const prior = seenIds.get(id);
      if (prior !== undefined) {
        const suggestion = slugify(`${title}-${r['Date start'] ?? ''}`);
        throw new Error(
          `Duplicate seed id "${id}" in seed/${name} (title: ${title}); already claimed by ${prior}. ` +
            `Give this row a unique "Seed ID", e.g. "${suggestion}".`,
        );
      }
      seenIds.set(id, `${name}: ${title}`);

      const qid = (r.Wikidata ?? '').trim() || null;
      const ingestVersion = r['Ingest version'] ?? (isUniversalFile ? UNIVERSAL_VERSION : SEED_VERSION);
      const displayTitle = (r['Display title'] ?? '').trim() || null;
      const dateEnd = (r['Date end'] ?? '').toString().trim() || null;

      // --- universal promote: reuse the dump's row for the same event ---
      const action = r.Action ?? (qid ? 'promote' : 'insert');
      if (universal && action === 'promote' && qid) {
        const dumpRow = findDumpRow.get(qid) as { id: string; title: string; scope: string | null } | undefined;
        if (dumpRow) {
          promote.run({
            id: qid,
            display_title: displayTitle ?? title,
            blurb: r.Blurb ?? null,
            date_start: r['Date start'] || null,
            date_end: dateEnd,
            date_precision: r.Precision ?? null,
            notability: typeof r.Notability === 'number' ? r.Notability : 1,
            source_patch: JSON.stringify({ universal: id, seed: name.replace(/\.json$/, '') }),
          });
          dropStale.run(id, ingestVersion);
          promoted++;
          total++;
          continue;
        }
        fellBack++; // no dump row yet (slice test, or an era Wikidata files as a 'period'): insert below
      }

      upsert.run({
        id,
        title,
        display_title: displayTitle,
        blurb: r.Blurb ?? null,
        date_start: r['Date start'],
        date_end: dateEnd,
        date_precision: r.Precision,
        lat: typeof r.Lat === 'number' ? r.Lat : null,
        lng: typeof r.Lng === 'number' ? r.Lng : null,
        scope: universal ? 'universal' : r['Scope (intended)'],
        category: r.Category ?? 'milestone',
        notability: typeof r.Notability === 'number' ? r.Notability : universal ? 1 : null,
        source_url: r['Source URL'] ?? (qid ? 'http://www.wikidata.org/entity/' + qid : null),
        source_ids: JSON.stringify({ seed: name.replace(/\.json$/, ''), place: r.Place ?? null, ...(qid ? { wikidata: qid } : {}) }),
        ingest_version: ingestVersion,
      });
      total++;
    }
  });
  tx(rows);
  console.log(`Seeded ${rows.length} rows from seed/${name}`);
}

for (const f of FILES) loadFile(f);

// Rebuild external-content FTS so the new rows are searchable.
db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);

const seedCount = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ingest_version LIKE 'seed-%'`).get() as any).c;
const universalCount = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE scope = 'universal'`).get() as any).c;
const grand = (db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as any).c;
console.log(`\nUpserted ${total} curated rows. Seed rows in DB: ${seedCount}. Total events: ${grand}.`);
console.log(`Universal tier: ${universalCount} rows (${promoted} dump rows promoted in place, ${fellBack} inserted because no dump row exists for their QID).`);
console.log('Next: npm run score   (computes significance + reach; preserves authored scope for seed + universal rows)');
db.close();
