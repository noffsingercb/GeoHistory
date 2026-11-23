/** Read-only inventory. A missing QID may be an intentional curated fallback. */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type UniversalSeed = { Title?: string; Wikidata?: string | null; Action?: 'insert' | 'promote' | null; Tier?: string | null; 'Scope (intended)'?: string | null };
export function missingPromotions(rows: UniversalSeed[], hasDumpRow: (qid: string) => boolean): Array<{ qid: string; title: string }> {
  return rows.flatMap(row => {
    const qid = row.Wikidata?.trim();
    const universal = row.Tier === 'universal' || row['Scope (intended)'] === 'universal';
    const action = row.Action ?? (qid ? 'promote' : 'insert');
    return universal && qid && action === 'promote' && !hasDumpRow(qid) ? [{ qid, title: row.Title?.trim() ?? '' }] : [];
  });
}

function main() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const file = join(dir, '..', 'seed', 'universal-v0.1.json');
  const dbPath = process.env.GEOHISTORY_DB ?? 'events.sqlite';
  const rows = JSON.parse(readFileSync(file, 'utf8')) as UniversalSeed[];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Deliberately mirrors seed.ts's current dump-row predicate.
    const find = db.prepare("SELECT 1 FROM events WHERE id = ? AND ingest_version NOT LIKE 'seed-%'");
    const missing = missingPromotions(rows, qid => Boolean(find.get(qid)));
    console.log(JSON.stringify({ db: dbPath, missing, note: 'Review each fallback; absence does not establish an error.' }, null, 2));
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
