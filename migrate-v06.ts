import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

// ===================== schema v0.6 migration =====================
// Brings a dump-v0.5 events.sqlite up to the v0.6 schema IN PLACE so the v0.6
// engine, seed and scorer can be exercised on the currently shipped data before
// the full dump re-ingest finishes (that run takes hours; this takes seconds).
//
//   - appends coord_source, category_root, wikidata_types, sitelinks, country_id,
//     participants, deaths (the last three stay NULL: only the dump carries them,
//     so expand-participants.ts is a no-op on a migrated file)
//   - rebuilds the events table so the CHECK constraints admit scope='universal'
//     and founding_kind='institution' / 'city' (SQLite cannot ALTER a CHECK, so the
//     table is copied, dropped and renamed; rowids are preserved for the FTS index)
//   - creates the v0.6 indexes (idx_events_end_year, idx_events_country, ...)
//   - backfills sitelinks from notability (notability = min(1, sitelinks/100),
//     so anything at 1.0 is a lower bound and is flagged in meta)
//
// Idempotent: a file that is already v0.6 is left alone. Takes a copy first anyway:
//   Copy-Item events.sqlite events.v05.sqlite
//   npm run migrate            (or: $env:GEOHISTORY_DB="events.v05.sqlite"; npm run migrate)

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';
const NEW_COLUMNS = ['coord_source', 'category_root', 'wikidata_types', 'sitelinks', 'country_id', 'participants', 'deaths'];

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // must be set outside a transaction

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
const eventsDdl = schema.match(/CREATE TABLE IF NOT EXISTS events \([\s\S]*?\n\);/)?.[0];
if (!eventsDdl) throw new Error('schema.sql: could not find the events table definition');

const columnsOf = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const currentDdl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`).get() as { sql: string } | undefined)?.sql ?? '';

const missing = NEW_COLUMNS.filter((c) => !columnsOf('events').includes(c));
const checksStale = !currentDdl.includes("'universal'") || !currentDdl.includes("'institution'") || !currentDdl.includes("'city'");

if (missing.length === 0 && !checksStale) {
  console.log(`${DB_PATH} is already on schema v0.6; nothing to do.`);
  db.close();
  process.exit(0);
}

const before = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
console.log(`${DB_PATH}: ${before.toLocaleString()} events. Missing columns: ${missing.join(', ') || 'none'}. CHECK constraints stale: ${checksStale}.`);

db.exec('BEGIN');
try {
  // 1. Build the v0.6 table beside the old one, straight from schema.sql so the
  //    two can never drift, then copy every column both tables share.
  db.exec(eventsDdl.replace('CREATE TABLE IF NOT EXISTS events (', 'CREATE TABLE events_v06 ('));
  const shared = columnsOf('events').filter((c) => columnsOf('events_v06').includes(c));
  const list = shared.map((c) => `"${c}"`).join(', ');
  db.exec(`INSERT INTO events_v06 (rowid, ${list}) SELECT rowid, ${list} FROM events`);

  // 2. Swap. Dropping the content table under an external-content FTS5 index is
  //    allowed; the index is rebuilt below once the name points at the new table.
  db.exec('DROP TABLE events');
  db.exec('ALTER TABLE events_v06 RENAME TO events');

  // 3. Recreate every index from schema.sql (they died with the old table) and
  //    re-point the FTS index at the preserved rowids.
  db.exec(schema);
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`);

  // 4. Backfill what can be recovered without the dump.
  db.exec(`UPDATE events SET sitelinks = CAST(ROUND(notability * 100) AS INTEGER) WHERE sitelinks IS NULL AND notability IS NOT NULL`);
  //    dump-v0.5 placed conflict/founding/discovery/event rows on their own P625 only;
  //    election/treaty/milestone rows may sit on a country centroid and cannot be told
  //    apart after the fact, so they get 'unknown' (score.ts treats that like an own point).
  db.exec(`UPDATE events SET coord_source = 'P625'   WHERE coord_source IS NULL AND ingest_version LIKE 'dump-%' AND category IN ('conflict', 'founding', 'discovery', 'event')`);
  db.exec(`UPDATE events SET coord_source = 'unknown' WHERE coord_source IS NULL AND ingest_version LIKE 'dump-%' AND category IN ('election', 'treaty', 'milestone')`);
  db.exec(`UPDATE events SET coord_source = 'P19'    WHERE coord_source IS NULL AND ingest_version LIKE 'dump-%' AND category = 'birth'`);
  db.exec(`UPDATE events SET coord_source = 'P20'    WHERE coord_source IS NULL AND ingest_version LIKE 'dump-%' AND category = 'death'`);

  const setMeta = db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  setMeta.run('schema_version', 'v0.6');
  setMeta.run('schema_migrated_from', currentDdl.includes("'universal'") ? 'v0.6-partial' : 'v0.5');
  setMeta.run('sitelinks_note', 'backfilled from notability by migrate-v06.ts: exact below 100, a lower bound at 100');

  const after = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
  if (after !== before) throw new Error(`row count changed during migration (${before} -> ${after}); rolled back`);
  db.exec('COMMIT');
  console.log(`Migrated ${after.toLocaleString()} events to schema v0.6. Indexes and FTS rebuilt.`);
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
} finally {
  db.close();
}
