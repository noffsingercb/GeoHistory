import Database from 'better-sqlite3';
import { isMedia } from './classify';

// ===================== Creative-work pruner (post-ingest, no re-ingest) =====================
// Removes films, television series, games, franchises and other creative works
// that ingest-dump.ts admitted as event / milestone / founding rows.
//
//   npm run prune:media                     -> review detected rows + verdicts
//   npm run prune:media -- --dry             -> explicit review-only mode
//   npm run prune:media -- --keep="A|B"      -> protect titles (case-insensitive)
//   npm run prune:media -- --apply           -> DELETE, rebuild FTS, stamp meta
//
// After applying, re-run `npm run score` so era-normalized significance is
// recomputed without the pruned rows. NOTE: that pass also restamps
// meta.dataset_version to the modal ingest_version.
//
// Never deleted: seed rows, universal rows, participant-expanded rows (P710).

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

const apply = hasFlag('apply');
const dry = hasFlag('dry');
if (apply && dry) throw new Error('Choose either --dry or --apply, not both.');

const keepSet = new Set(
  (flagValue('keep') ?? '').split('|').map((title) => title.trim().toLowerCase()).filter(Boolean),
);
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const hasCoordSource = (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>)
  .some((column) => column.name === 'coord_source');
const PROTECTED = `(ingest_version LIKE 'seed-%' OR scope IS 'universal'${hasCoordSource ? " OR COALESCE(coord_source, '') = 'P710'" : ''})`;
const coordSourceColumn = hasCoordSource ? 'coord_source' : 'NULL AS coord_source';

interface MediaRow {
  id: string;
  title: string;
  blurb: string | null;
  wikidata_types: string | null;
  category: string | null;
  scope: string | null;
  significance: number | null;
  ingest_version: string;
  coord_source: string | null;
}

const selectRows = (where: string): MediaRow[] => db.prepare(`
  SELECT id, title, blurb, wikidata_types, category, scope, significance,
         ingest_version, ${coordSourceColumn}
  FROM events
  WHERE category IN ('event', 'milestone', 'founding')
    AND ${where}
  ORDER BY significance DESC, title ASC, id ASC
`).all() as MediaRow[];

const rows = selectRows(`NOT ${PROTECTED}`)
  .filter((row) => isMedia(row.blurb, row.wikidata_types));
const protectedMatches = selectRows(PROTECTED)
  .filter((row) => isMedia(row.blurb, row.wikidata_types));
const totalRows = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
const isKept = (row: MediaRow): boolean => keepSet.has(row.title.toLowerCase());
const doomed = rows.filter((row) => !isKept(row));

console.log(
  `Detected ${rows.length.toLocaleString()} unprotected media rows ` +
  `(${totalRows.toLocaleString()} rows in the DB; ${protectedMatches.length.toLocaleString()} protected media matches excluded).\n`,
);
console.log('  VERDICT  SIG    SCOPE       CATEGORY    ID             TITLE');
for (const row of rows) {
  const verdict = isKept(row) ? 'KEEP  ' : 'DELETE';
  const significance = (row.significance ?? 0).toFixed(3).padStart(5);
  console.log(
    `  ${verdict}   ${significance}  ${(row.scope ?? '-').padEnd(10)}  ` +
    `${(row.category ?? '-').padEnd(10)}  ${row.id.padEnd(13)}  ${row.title}`,
  );
}

console.log(`\nKept:    ${rows.length - doomed.length} rows`);
console.log(
  `Doomed:  ${doomed.length.toLocaleString()} rows ` +
  `(${totalRows === 0 ? '0.00' : ((doomed.length / totalRows) * 100).toFixed(2)}% of the dataset)`,
);
console.log(`Protected media matches excluded: ${protectedMatches.length.toLocaleString()} (seed / universal / expanded).`);

if (!apply) {
  console.log('\nREVIEW ONLY. Nothing deleted.');
  console.log(`To delete the ${doomed.length.toLocaleString()} rows above:  npm run prune:media -- --apply`);
  console.log('To protect titles first:                 npm run prune:media -- --keep="Title A|Title B"');
  db.close();
  process.exit(0);
}

const del = db.prepare(`
  DELETE FROM events
  WHERE id = @id
    AND NOT ${PROTECTED}
`);

let deleted = 0;
const run = db.transaction(() => {
  for (const row of doomed) {
    const changes = del.run({ id: row.id }).changes;
    if (changes !== 1) {
      throw new Error(`Safety check failed while deleting ${row.id}: expected 1 row, deleted ${changes}.`);
    }
    deleted += changes;
  }
});
run();

db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
db.prepare(`INSERT INTO meta(key, value) VALUES('last_media_prune', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  .run(`${deleted} media rows removed at ${new Date().toISOString()}`);

console.log(`\nDeleted ${deleted.toLocaleString()} media rows. Rebuilt FTS.`);
console.log(`Remaining: ${(totalRows - deleted).toLocaleString()} events.`);
console.log('\nNext: npm run score   (recomputes era-normalized significance without the pruned rows)');
db.close();
