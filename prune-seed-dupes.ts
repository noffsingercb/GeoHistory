import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

// ===================== Seed/dump duplicate pruner =====================
// Applies the hand-adjudicated verdicts in seed/dupe/dupe-drop.tsv and
// seed/dupe/dupe-merge.tsv.
//
//   npm run prune:dupes             -> apply
//   npm run prune:dupes -- --dry-run -> report only, touch nothing
//
// Background. The curated Wikipedia timeline seed rows and the Wikidata dump
// overlap, but not in the shape you would expect. Both datasets title rows
// after PLACES, so a seed row "Albania declares its independence from the
// Ottoman Empire" (1912-11-28) collides with the dump's entity row for the
// country Albania, whose founding date is that same day. Same fact, two
// shapes. 547 candidate pairs were adjudicated one at a time; the TSVs in
// seed/dupe/ are that adjudication, and this script is the only mechanism
// that should apply them.
//
// Two verdict classes are actionable:
//
//   drop-seed  -- the dump row wins outright (real coordinates, a derived
//                 scope, and a proper event title where ours is place-titled,
//                 e.g. "Battle of Trafalgar" vs our "Trafalgar"). The seed row
//                 is removed from seed/*.json and from the DB. 258 rows.
//
//   merge-date -- same fact, but the dump row carries a YEAR-precision
//                 placeholder date (Ghana's independence sits at 1957-01-01)
//                 while ours is exact (1957-03-06). Naively dropping our row
//                 would coarsen 54 national independence dates to January 1st.
//                 So: copy our date onto the dump row, THEN drop our row.
//
// A third class, keep-both, is deliberately NOT consumed here. Those are
// same-title/different-event pairs (Nigeria alone has four seed rows against
// one dump entity: independence, then three renamings) plus title collisions
// with same-named American settlements -- our Athens matched a village in
// Michigan, our Waterloo matched Monroe County, Illinois. dupe-keep.tsv is
// committed for auditing only; nothing reads it.
//
// Ordering. This runs AFTER `npm run seed` and AFTER `npm run ingest:dump`,
// and BEFORE `npm run score`. Re-ingesting the dump restores the placeholder
// dates, so the merge pass must run again after any re-ingest -- which is
// exactly why the verdicts live in version-controlled files rather than in a
// one-time manual edit. Scoring afterwards is required: removing 312 rows
// shifts the significance percentiles.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

// The verdict files are committed under seed/dupe/; --dir points elsewhere.
const dirArg = process.argv.findIndex((a) => a === '--dir');
const TSV_DIR =
  dirArg !== -1 && process.argv[dirArg + 1] ? process.argv[dirArg + 1] : join(__dirname, 'seed', 'dupe');

// Only the timeline files can contain adjudicated rows; the curated invention
// files were never part of the duplicate scan, so they are left untouched.
const SEED_FILES = [
  'timeline-wikipedia-1-pre1700.json',
  'timeline-wikipedia-2-1700-1849.json',
  'timeline-wikipedia-3-1850-1919.json',
  'timeline-wikipedia-4-1920-1979.json',
  'timeline-wikipedia-5-1980-present.json',
];

interface RawRow {
  Title: string;
  'Date start': string;
  'Seed ID'?: string | null;
  [k: string]: unknown;
}

// Must match seed.ts exactly, or the ids computed here will not line up with
// the ids the loader wrote to the DB.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function rowId(r: RawRow): string {
  const explicit = (r['Seed ID'] ?? '').toString().trim();
  return `seed:${slugify(explicit || (r.Title ?? '').trim())}`;
}

// ---------- TSV reading ----------
// Columns are addressed by header name, not position, so re-ordering or adding
// a column to the adjudication output cannot silently corrupt the run.
function readTsv(name: string): Array<Record<string, string>> {
  const path = join(TSV_DIR, name);
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. The verdict files belong in seed/dupe/, or pass --dir <folder>.`);
  }
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error(`${name} is empty.`);
  const header = lines[0].split('\t');
  for (const required of ['seed_id']) {
    if (!header.includes(required)) throw new Error(`${name} has no "${required}" column. Header: ${header.join(', ')}`);
  }
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = (cells[i] ?? '').trim()));
    return row;
  });
}

const dropPairs = readTsv('dupe-drop.tsv');
const mergePairs = readTsv('dupe-merge.tsv');

// A seed row can appear in more than one pair (20 of them matched multiple
// dump rows), so collapse to distinct ids.
const dropIds = new Set(dropPairs.map((r) => r.seed_id).filter(Boolean));
const mergeIds = new Set(mergePairs.map((r) => r.seed_id).filter(Boolean));

// Both lists end in the same action -- removing the seed row -- so an id in
// both would mean the adjudication contradicted itself about which date wins.
const overlap = [...mergeIds].filter((id) => dropIds.has(id));
if (overlap.length > 0) {
  throw new Error(`${overlap.length} seed id(s) appear in BOTH dupe-drop.tsv and dupe-merge.tsv, which is contradictory: ${overlap.slice(0, 5).join(', ')}`);
}

const removeIds = new Set([...dropIds, ...mergeIds]);
console.log(`Verdicts loaded: ${dropPairs.length} drop pairs (${dropIds.size} rows), ${mergePairs.length} merge pairs (${mergeIds.size} rows) -> ${removeIds.size} seed rows to remove.`);
if (DRY_RUN) console.log('DRY RUN -- no files or database rows will be modified.\n');

// ---------- Pass 1: patch dump dates, then delete seed rows ----------
const db = new Database('events.sqlite');
db.pragma('journal_mode = WAL');

const getEvent = db.prepare(`SELECT id, title, date_start, date_precision FROM events WHERE id = ?`);
const patchDate = db.prepare(`UPDATE events SET date_start = @date_start, date_precision = @date_precision WHERE id = @id`);
const deleteEvent = db.prepare(`DELETE FROM events WHERE id = ? AND ingest_version LIKE 'seed-%'`);

let patched = 0;
let alreadyExact = 0;
const missingDump: string[] = [];

const runMerge = db.transaction(() => {
  for (const pair of mergePairs) {
    const dumpId = pair.dump_id;
    const seedDate = pair.seed_date;
    if (!dumpId || !seedDate) continue;

    const existing = getEvent.get(dumpId) as { date_start: string } | undefined;
    if (existing === undefined) {
      missingDump.push(`${dumpId} (${pair.dump_title})`);
      continue;
    }
    if (existing.date_start === seedDate) {
      alreadyExact++;
      continue;
    }
    // Seed dates in these 54 pairs are all full calendar dates; the whole point
    // of the merge is that they are more precise than what the dump carries.
    if (!DRY_RUN) patchDate.run({ id: dumpId, date_start: seedDate, date_precision: 'day' });
    patched++;
    if (patched <= 8) console.log(`  date  ${dumpId} ${pair.dump_title}: ${existing.date_start} -> ${seedDate}`);
  }
});
runMerge();
if (patched > 8) console.log(`  ... and ${patched - 8} more date patches`);
console.log(`Dump dates patched: ${patched} (${alreadyExact} already exact${missingDump.length ? `, ${missingDump.length} dump rows not found` : ''})`);
if (missingDump.length > 0) {
  console.log(`  not found: ${missingDump.slice(0, 5).join(', ')}${missingDump.length > 5 ? ` and ${missingDump.length - 5} more` : ''}`);
  console.log('  (expected if the dump has not been ingested into this database)');
}

let deleted = 0;
let absent = 0;
const runDelete = db.transaction(() => {
  for (const id of removeIds) {
    if (getEvent.get(id) === undefined) {
      absent++;
      continue;
    }
    if (!DRY_RUN) {
      const res = deleteEvent.run(id);
      deleted += res.changes;
    } else {
      deleted++;
    }
  }
});
runDelete();
console.log(`Seed rows deleted from events.sqlite: ${deleted} (${absent} already absent -- fine on a re-run)`);

// ---------- Pass 2: rewrite the seed JSON files ----------
// The DB delete alone is not enough: the next `npm run seed` would put every
// dropped row straight back. The JSON files are the source of truth.
let removedFromJson = 0;
const unmatched = new Set(removeIds);

for (const name of SEED_FILES) {
  const path = join(__dirname, 'seed', name);
  const rows = JSON.parse(readFileSync(path, 'utf8')) as RawRow[];
  const kept = rows.filter((r) => {
    const id = rowId(r);
    if (removeIds.has(id)) {
      unmatched.delete(id);
      removedFromJson++;
      return false;
    }
    return true;
  });

  const cut = rows.length - kept.length;
  if (cut > 0 && !DRY_RUN) writeFileSync(path, JSON.stringify(kept, null, 2) + '\n', 'utf8');
  console.log(`  seed/${name}: ${rows.length} -> ${kept.length} (-${cut})`);
}

console.log(`\nSeed rows removed from JSON: ${removedFromJson}`);
if (unmatched.size > 0) {
  // Non-fatal, but worth surfacing: an id in the verdicts that no JSON row
  // claims usually means a title or Seed ID was edited after adjudication.
  // On a second run this is EXPECTED for every id -- the rows are already gone.
  console.log(`NOTE: ${unmatched.size} verdict id(s) matched no row in the seed files.`);
  console.log('  On a first run this means a title or Seed ID drifted since adjudication.');
  console.log('  On a re-run it is expected: those rows have already been pruned.');
  for (const id of [...unmatched].slice(0, 10)) console.log(`  ${id}`);
  if (unmatched.size > 10) console.log(`  ... and ${unmatched.size - 10} more`);
}

// ---------- Finish ----------
if (!DRY_RUN) {
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);

  // Record the run in meta. This is not bookkeeping for its own sake:
  // server.ts derives the datasetBuild id reported by /v1/meta by counting the
  // prune stamps present in this table. prune.ts writes last_prune and
  // prune-series.ts writes last_series_prune, but this script wrote nothing --
  // so a database that had been through all three prunes still announced
  // itself as 'prune2', understating what had been done to it.
  //
  // That was survivable while the file sat on a workstation and could be
  // inspected directly. It stops being survivable once Step 1.4 bakes the
  // database into an immutable image, because the build id is then the only
  // handle anyone has on which artifact is deployed.
  //
  // The stamp is written on every apply, including re-runs that remove nothing
  // (deleted === 0). That is intentional -- the value records when the verdicts
  // were last applied, not only when they last changed something.
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(
    'last_dupe_prune',
    `${deleted} seed rows removed, ${patched} dump dates merged at ${new Date().toISOString()}`,
  );
}

const seedCount = (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ingest_version LIKE 'seed-%'`).get() as any).c;
const grand = (db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as any).c;
console.log(`\nSeed rows in DB: ${seedCount}. Total events: ${grand}.`);
console.log(DRY_RUN ? 'Dry run complete -- nothing was written.' : 'Next: npm run rescope:foundings && npm run score   (percentiles shift when rows are removed)');
db.close();
