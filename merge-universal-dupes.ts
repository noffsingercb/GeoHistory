import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';

// ================= Universal/non-universal duplicate merger =================
// Consumes hand-adjudicated verdicts from seed/dupe/dupe-merge-universal.tsv.
//
//   npx tsx merge-universal-dupes.ts         -> review only
//   npx tsx merge-universal-dupes.ts --apply -> apply changes
//
// schema.sql confirms source_url is the Wikipedia/source-link column.
// Run after both seed and ingest:dump, and before scoring: deleting rows can
// shift significance percentiles.

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';

const dirArg = process.argv.findIndex((arg) => arg === '--dir');
const TSV_DIR =
  dirArg !== -1 && process.argv[dirArg + 1]
    ? process.argv[dirArg + 1]
    : join(__dirname, 'seed', 'dupe');

const VERDICT_FILE = 'dupe-merge-universal.tsv';
const SEED_FILES = [
  'timeline-wikipedia-1-pre1700.json',
  'timeline-wikipedia-2-1700-1849.json',
  'timeline-wikipedia-3-1850-1919.json',
  'timeline-wikipedia-4-1920-1979.json',
  'timeline-wikipedia-5-1980-present.json',
];

interface RawSeedRow {
  Title: string;
  'Date start': string;
  'Seed ID'?: string | null;
  [key: string]: unknown;
}

interface Verdict {
  keep_id: string;
  donor_id: string;
  donor_wiki_url: string;
  donor_blurb: string;
}

interface EventRow {
  id: string;
  title: string;
  scope: string | null;
  blurb: string | null;
  source_url: string | null;
  ingest_version: string;
}

// Copied verbatim from prune-seed-dupes.ts because it does not export these
// helpers. Keep synchronized with seed.ts and prune-seed-dupes.ts.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

function rowId(row: RawSeedRow): string {
  const explicit = (row['Seed ID'] ?? '').toString().trim().replace(/^seed:/, '');
  return `seed:${slugify(explicit || (row.Title ?? '').trim())}`;
}

// Columns are addressed by header name rather than position.
function readTsv(name: string): Verdict[] {
  const path = join(TSV_DIR, name);
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. The verdict file belongs in seed/dupe/, or pass --dir <folder>.`);
  }

  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`${name} is empty.`);

  const header = lines[0].split('\t');
  const requiredColumns = ['keep_id', 'donor_id', 'donor_wiki_url', 'donor_blurb'];
  for (const required of requiredColumns) {
    if (!header.includes(required)) {
      throw new Error(`${name} has no "${required}" column. Header: ${header.join(', ')}`);
    }
  }

  const verdicts: Verdict[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = line.split('\t');
    const raw: Record<string, string> = {};
    header.forEach((column, columnIndex) => {
      raw[column] = (cells[columnIndex] ?? '').trim();
    });

    const lineNumber = index + 2;
    const row: Verdict = {
      keep_id: raw.keep_id,
      donor_id: raw.donor_id,
      donor_wiki_url: raw.donor_wiki_url,
      donor_blurb: raw.donor_blurb,
    };

    // The committed template has one documentation-only example.
    if (row.keep_id.startsWith('EXAMPLE:')) {
      console.log(`Ignoring example row on line ${lineNumber}.`);
      continue;
    }
    if (!row.keep_id && !row.donor_id) continue;
    if (!row.keep_id || !row.donor_id) {
      throw new Error(`${name} line ${lineNumber} must contain both keep_id and donor_id.`);
    }
    if (row.keep_id === row.donor_id) {
      throw new Error(`${name} line ${lineNumber} uses the same id for keep_id and donor_id: ${row.keep_id}`);
    }
    verdicts.push(row);
  }

  return verdicts;
}

function preferredValue(tsvValue: string, liveValue: string | null): string | null {
  const fromTsv = tsvValue.trim();
  if (fromTsv) return fromTsv;
  const fromDatabase = liveValue?.trim() ?? '';
  return fromDatabase || null;
}

function shouldCopy(donorValue: string | null, keepValue: string | null): boolean {
  if (!donorValue) return false;
  const current = keepValue?.trim() ?? '';
  return current.length === 0 || donorValue.length > current.length;
}

const verdicts = readTsv(VERDICT_FILE);
const duplicateKeepIds = verdicts
  .map((verdict) => verdict.keep_id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);
const duplicateDonorIds = verdicts
  .map((verdict) => verdict.donor_id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);

if (duplicateKeepIds.length > 0) {
  throw new Error(`Duplicate keep_id verdict(s): ${[...new Set(duplicateKeepIds)].join(', ')}`);
}
if (duplicateDonorIds.length > 0) {
  throw new Error(`Duplicate donor_id verdict(s): ${[...new Set(duplicateDonorIds)].join(', ')}`);
}

console.log(`Verdicts loaded: ${verdicts.length}.`);
console.log(
  APPLY
    ? 'APPLY MODE -- database and seed JSON changes will be written.\n'
    : 'REVIEW ONLY -- pass --apply to write database or seed JSON changes.\n',
);

const db = new Database(DB_PATH);

try {
  if (APPLY) db.pragma('journal_mode = WAL');
  else db.pragma('query_only = ON');

  const getEvent = db.prepare(`
    SELECT id, title, scope, blurb, source_url, ingest_version
      FROM events
     WHERE id = ?
  `);
  const updateBlurb = db.prepare(`UPDATE events SET blurb = ? WHERE id = ?`);
  const updateSourceUrl = db.prepare(`UPDATE events SET source_url = ? WHERE id = ?`);
  const deleteEvent = db.prepare(`DELETE FROM events WHERE id = ? AND scope != 'universal'`);

  const resolved = verdicts.map((verdict) => ({
    verdict,
    keep: getEvent.get(verdict.keep_id) as EventRow | undefined,
    donor: getEvent.get(verdict.donor_id) as EventRow | undefined,
  }));

  // Validate every row before any write. An absent donor is allowed for an
  // idempotent re-run; any donor that still exists is guarded by live scope.
  const guardErrors: string[] = [];
  for (const { verdict, keep, donor } of resolved) {
    if (!keep) guardErrors.push(`keep row not found: ${verdict.keep_id}`);
    else if (keep.scope !== 'universal') {
      guardErrors.push(`keep row is scope=${JSON.stringify(keep.scope)}, not "universal": ${verdict.keep_id}`);
    }
    if (donor?.scope === 'universal') {
      guardErrors.push(`refusing to delete universal donor: ${verdict.donor_id}`);
    }
  }

  if (guardErrors.length > 0) {
    throw new Error(
      `Verdict guard failed; no changes were made:\n${guardErrors.map((error) => `  - ${error}`).join('\n')}`,
    );
  }

  let blurbsCopied = 0;
  let sourceUrlsCopied = 0;
  let deleted = 0;
  let absentDonors = 0;
  const seedDonorIds = new Set(
    verdicts.map((verdict) => verdict.donor_id).filter((id) => id.startsWith('seed:')),
  );

  const runMerge = db.transaction(() => {
    for (const { verdict, keep, donor } of resolved) {
      if (!keep) throw new Error(`Keep row disappeared before merge: ${verdict.keep_id}`);
      if (!donor) {
        absentDonors++;
        console.log(`  absent ${verdict.donor_id} -- already deleted; keeping ${verdict.keep_id}`);
        continue;
      }

      // Re-read inside the transaction so stale verdicts or a concurrent scope
      // promotion cannot bypass the guard.
      const currentKeep = getEvent.get(verdict.keep_id) as EventRow | undefined;
      const currentDonor = getEvent.get(verdict.donor_id) as EventRow | undefined;
      if (!currentKeep) throw new Error(`Keep row disappeared during merge: ${verdict.keep_id}`);
      if (currentKeep.scope !== 'universal') {
        throw new Error(`Keep row is no longer universal: ${verdict.keep_id} (${currentKeep.scope})`);
      }
      if (!currentDonor) {
        absentDonors++;
        console.log(`  absent ${verdict.donor_id} -- already deleted; keeping ${verdict.keep_id}`);
        continue;
      }
      if (currentDonor.scope === 'universal') {
        throw new Error(`Refusing to delete donor promoted to universal: ${verdict.donor_id}`);
      }

      const donorBlurb = preferredValue(verdict.donor_blurb, currentDonor.blurb);
      const donorSourceUrl = preferredValue(verdict.donor_wiki_url, currentDonor.source_url);
      const copyBlurb = shouldCopy(donorBlurb, currentKeep.blurb);
      const copySourceUrl = shouldCopy(donorSourceUrl, currentKeep.source_url);

      console.log(
        `  ${APPLY ? 'merge' : 'would merge'} ${currentDonor.id} (${currentDonor.title}) -> ${currentKeep.id} (${currentKeep.title})`,
      );
      console.log(`    blurb: ${copyBlurb ? 'copy donor value' : 'keep existing value'}`);
      console.log(`    source_url: ${copySourceUrl ? 'copy donor value' : 'keep existing value'}`);
      console.log(`    donor: ${APPLY ? 'delete' : 'would delete'} after copying`);

      if (copyBlurb) {
        if (APPLY) updateBlurb.run(donorBlurb, currentKeep.id);
        blurbsCopied++;
      }
      if (copySourceUrl) {
        if (APPLY) updateSourceUrl.run(donorSourceUrl, currentKeep.id);
        sourceUrlsCopied++;
      }
      if (APPLY) {
        const result = deleteEvent.run(currentDonor.id);
        if (result.changes !== 1) {
          throw new Error(`Donor delete guard rejected ${currentDonor.id}; transaction rolled back.`);
        }
        deleted += result.changes;
      } else {
        deleted++;
      }
    }

    if (APPLY) {
      db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
      db.prepare(
        `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(
        'last_universal_merge',
        `${deleted} donor rows removed, ${blurbsCopied} blurbs copied, ${sourceUrlsCopied} source URLs copied at ${new Date().toISOString()}`,
      );
    }
  });

  runMerge();
  console.log(
    `\nDatabase: ${blurbsCopied} blurb copy/copies, ${sourceUrlsCopied} source_url copy/copies, ${deleted} donor deletion(s), ${absentDonors} donor(s) already absent.`,
  );

  // Remove seed donors from the timeline JSON source of truth so `npm run
  // seed` cannot restore them on the next rebuild.
  let removedFromJson = 0;
  const unmatchedSeedIds = new Set(seedDonorIds);

  for (const name of SEED_FILES) {
    const path = join(__dirname, 'seed', name);
    const rows = JSON.parse(readFileSync(path, 'utf8')) as RawSeedRow[];
    const kept = rows.filter((row) => {
      const id = rowId(row);
      if (!seedDonorIds.has(id)) return true;
      unmatchedSeedIds.delete(id);
      removedFromJson++;
      return false;
    });

    const removed = rows.length - kept.length;
    if (removed > 0 && APPLY) {
      writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
    }
    console.log(`  seed/${name}: ${rows.length} -> ${kept.length} (-${removed})`);
  }

  console.log(`\nSeed JSON: ${APPLY ? 'removed' : 'would remove'} ${removedFromJson} row(s).`);
  if (unmatchedSeedIds.size > 0) {
    console.log(`NOTE: ${unmatchedSeedIds.size} seed donor verdict(s) matched no timeline JSON row.`);
    console.log('  This is expected on a re-run; on a first run it may indicate Seed ID drift.');
    for (const id of [...unmatchedSeedIds].slice(0, 10)) console.log(`  ${id}`);
    if (unmatchedSeedIds.size > 10) console.log(`  ... and ${unmatchedSeedIds.size - 10} more`);
  }

  const grand = (db.prepare(`SELECT COUNT(*) AS count FROM events`).get() as { count: number }).count;
  console.log(`\nTotal events: ${grand}.`);
  console.log(
    APPLY
      ? 'Universal duplicate merge complete. Next: run scoring after all row-pruning passes.'
      : 'Review complete -- nothing was written. Re-run with --apply to apply these verdicts.',
  );
} finally {
  db.close();
}
