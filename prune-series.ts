import Database from 'better-sqlite3';

// ===================== Recurring-series pruner (post-ingest, no re-ingest) =====================
// Removes "row piles": recurring events (annual championships, grands prix, film
// festivals) where Wikipedia's COMPLETENESS masquerades as historical
// significance. notabilityOf = min(1, sitelinks/100) rewards thorough coverage,
// and a devoted fan base produces one well-translated article per edition, so
// every edition independently clears the significance floor.
//
// This is a multiplicity defect, not a scoring defect. No category weight fixes
// it (these rows share the `event` category with history worth keeping) and no
// notability floor fixes it (each edition's notability is legitimately
// mid-range). The only sound lever is removing the redundant rows.
//
// DETECTION. Title matches '[12][0-9][0-9][0-9] *' (leading 4-digit year); strip
// the year; group on the remainder; a remainder shared by >= minEditions rows is
// a series. The grouping step is the safety mechanism: a naive "delete
// year-prefixed titles" rule would delete the 1906 San Francisco earthquake,
// currently one of the strongest entries the engine returns. Its remainder
// appears exactly once, so it never qualifies.
//
//   npm run prune:series                     -> review ALL detected series + verdicts
//   npm run prune:series -- --min=8          -> raise the editions threshold
//   npm run prune:series -- --keep="A|B"     -> keep extra series (case-insensitive)
//   npm run prune:series -- --apply          -> DELETE, rebuild FTS, stamp meta
//
// After applying, re-run `npm run score` so era-normalized significance is
// recomputed without the pruned rows. NOTE: that pass also restamps
// meta.dataset_version to the modal ingest_version.
//
// Never deleted: seed rows, universal rows, participant-expanded rows (P710).

const SERIES_GLOB = '[12][0-9][0-9][0-9] *';

/**
 * Series preserved in full. 'United States presidential election' is the one
 * entry on the observed list that is genuine political history rather than a
 * recurring fixture: 59 editions from 1792, avg significance 0.49 (roughly
 * double every sporting series), and a presidential election is exactly the kind
 * of national event a life timeline should sit inside.
 */
const DEFAULT_KEEP = [
  'United States presidential election',
];

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const hasFlag = (name: string) => args.includes(`--${name}`);

const minEditions = Math.max(2, parseInt(flagValue('min') ?? '5', 10) || 5);
const apply = hasFlag('apply');
const extraKeep = (flagValue('keep') ?? '').split('|').map((s) => s.trim()).filter(Boolean);
const keepSet = new Set([...DEFAULT_KEEP, ...extraKeep].map((s) => s.toLowerCase()));
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Rows this script may never remove. Counted as `protected` per series below.
const hasCoordSource = (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).some((c) => c.name === 'coord_source');
const PROTECTED = `(ingest_version LIKE 'seed-%' OR scope IS 'universal'${hasCoordSource ? " OR COALESCE(coord_source, '') = 'P710'" : ''})`;

interface SeriesRow {
  series: string;
  n: number;
  first_yr: string;
  last_yr: string;
  avg_notability: number;
  avg_sig: number;
  category: string | null;
  seeded: number;
}

const series = db.prepare(`
  SELECT substr(title, 6)                                        AS series,
         COUNT(*)                                                AS n,
         MIN(substr(date_start, 1, 4))                           AS first_yr,
         MAX(substr(date_start, 1, 4))                           AS last_yr,
         ROUND(AVG(notability), 3)                               AS avg_notability,
         ROUND(AVG(significance), 3)                             AS avg_sig,
         MIN(category)                                           AS category,
         SUM(CASE WHEN ${PROTECTED} THEN 1 ELSE 0 END)           AS seeded
  FROM events
  WHERE title GLOB @glob
  GROUP BY series
  HAVING n >= @min
  ORDER BY n DESC, series ASC
`).all({ glob: SERIES_GLOB, min: minEditions }) as SeriesRow[];

if (series.length === 0) {
  console.log(`No year-prefixed series with ${minEditions}+ editions found.`);
  db.close();
  process.exit(0);
}

const totalRows = (db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as any).c as number;
const isKept = (s: SeriesRow) => keepSet.has(s.series.toLowerCase());

// Protected rows (seed / universal / participant-expanded) are never deleted, so
// a fully-protected series is effectively kept no matter what the verdict says.
const doomedRowCount = series
  .filter((s) => !isKept(s))
  .reduce((acc, s) => acc + (s.n - s.seeded), 0);

console.log(`Detected ${series.length} series with ${minEditions}+ editions (${totalRows.toLocaleString()} rows in the DB).\n`);
console.log('  VERDICT  EDITIONS  YEARS       AVG_SIG  CATEGORY    SERIES');
for (const s of series) {
  const verdict = isKept(s) ? 'KEEP  ' : 'DELETE';
  const years = `${s.first_yr}-${s.last_yr}`.padEnd(11);
  const seedNote = s.seeded > 0 ? `  (${s.seeded} protected: seed / universal / expanded)` : '';
  console.log(
    `  ${verdict}   ${String(s.n).padStart(6)}    ${years} ${String(s.avg_sig ?? 0).padStart(7)}  ` +
    `${(s.category ?? '-').padEnd(10)}  ${s.series}${seedNote}`,
  );
}

console.log(`\nKept:    ${series.filter(isKept).length} series`);
console.log(`Doomed:  ${series.length - series.filter(isKept).length} series / ${doomedRowCount.toLocaleString()} rows ` +
  `(${((doomedRowCount / totalRows) * 100).toFixed(2)}% of the dataset)`);

const sample = db.prepare(`
  SELECT title, substr(date_start, 1, 4) AS yr, significance
  FROM events
  WHERE title GLOB @glob
    AND NOT ${PROTECTED}
    AND substr(title, 6) IN (SELECT substr(title, 6) FROM events WHERE title GLOB @glob GROUP BY substr(title, 6) HAVING COUNT(*) >= @min)
  ORDER BY significance DESC
  LIMIT 15
`).all({ glob: SERIES_GLOB, min: minEditions }) as Array<{ title: string; yr: string; significance: number }>;

console.log('\nHighest-scoring rows in the detected set (sanity check -- confirm none of these are real history):');
for (const r of sample) {
  const mark = keepSet.has(r.title.slice(5).toLowerCase()) ? 'keep  ' : 'delete';
  console.log(`  ${mark}  ${String(r.significance).padStart(5)}  ${r.yr}  ${r.title}`);
}

if (!apply) {
  console.log('\nREVIEW ONLY. Nothing deleted.');
  console.log(`To delete the ${doomedRowCount.toLocaleString()} rows above:  npm run prune:series -- --apply`);
  console.log('To protect more series first:              npm run prune:series -- --keep="Summer Olympics|FIFA World Cup"');
  db.close();
  process.exit(0);
}

const del = db.prepare(`
  DELETE FROM events
  WHERE title GLOB @glob
    AND substr(title, 6) = @series
    AND NOT ${PROTECTED}
`);

let deleted = 0;
const run = db.transaction(() => {
  for (const s of series) {
    if (isKept(s)) continue;
    deleted += del.run({ glob: SERIES_GLOB, series: s.series }).changes;
  }
});
run();

db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
db.prepare(`INSERT INTO meta(key, value) VALUES('last_series_prune', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  .run(`${series.length - series.filter(isKept).length} series (min ${minEditions} editions) removed ${deleted} rows at ${new Date().toISOString()}`);

console.log(`\nDeleted ${deleted.toLocaleString()} rows across ${series.length - series.filter(isKept).length} series. Rebuilt FTS.`);
console.log(`Remaining: ${(totalRows - deleted).toLocaleString()} events.`);
console.log('\nNext: npm run score   (recomputes era-normalized significance without the pruned rows)');
db.close();
