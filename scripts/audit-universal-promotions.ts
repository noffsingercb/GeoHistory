/** Read-only inventory. A missing QID may be an intentional curated fallback. */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type FallbackException = { qid: string; reason: string };

export type UniversalSeed = { Title?: string; Wikidata?: string | null; Action?: 'insert' | 'promote' | null; Tier?: string | null; 'Scope (intended)'?: string | null };
export function missingPromotions(rows: UniversalSeed[], hasDumpRow: (qid: string) => boolean): Array<{ qid: string; title: string }> {
  return rows.flatMap(row => {
    if (!(row.Title ?? '').trim()) return []; // seed.ts skips untitled rows
    const qid = row.Wikidata?.trim();
    const universal = row.Tier === 'universal' || row['Scope (intended)'] === 'universal';
    const action = row.Action ?? (qid ? 'promote' : 'insert');
    return universal && qid && action === 'promote' && !hasDumpRow(qid) ? [{ qid, title: row.Title?.trim() ?? '' }] : [];
  });
}

/** Explicitly reviewed exceptions only; never infer approval from a missing row. */
export function reviewFallbacks(
  missing: Array<{ qid: string; title: string }>,
  exceptions: FallbackException[],
  eligibleQids: Set<string>,
): { expected: Array<{ qid: string; title: string; reason: string }>; unreviewed: Array<{ qid: string; title: string }> } {
  const allowed = new Map<string, string>();
  for (const item of exceptions) {
    if (!item || typeof item.qid !== 'string' || !/^Q[1-9][0-9]*$/.test(item.qid) ||
        typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('Each fallback exception needs a valid QID and a non-empty review reason.');
    if (allowed.has(item.qid)) throw new Error(`Duplicate fallback exception: ${item.qid}`);
    if (!eligibleQids.has(item.qid)) throw new Error(`Fallback exception does not match a universal promotion: ${item.qid}`);
    allowed.set(item.qid, item.reason.trim());
  }
  const expected: Array<{ qid: string; title: string; reason: string }> = [];
  const unreviewed: Array<{ qid: string; title: string }> = [];
  for (const item of missing) {
    const reason = allowed.get(item.qid);
    if (reason) expected.push({ ...item, reason });
    else unreviewed.push(item);
  }
  return { expected, unreviewed };
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--strict')) throw new Error('Usage: npm run audit:universal-promotions -- [--strict]');
  const strict = args.includes('--strict');
  const dir = dirname(fileURLToPath(import.meta.url));
  const file = join(dir, '..', 'seed', 'universal-v0.1.json');
  const exceptionPath = process.env.UNIVERSAL_FALLBACK_EXCEPTIONS ?? join(dir, '..', 'seed', 'universal-fallback-exceptions.json');
  const dbPath = process.env.GEOHISTORY_DB ?? 'events.sqlite';
  const rows = JSON.parse(readFileSync(file, 'utf8')) as UniversalSeed[];
  const exceptions: unknown = JSON.parse(readFileSync(exceptionPath, 'utf8'));
  if (!Array.isArray(exceptions)) throw new Error('Fallback exceptions must be an array.');
  const eligibleQids = new Set(missingPromotions(rows, () => false).map(row => row.qid));
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Deliberately mirrors seed.ts's current dump-row predicate.
    const find = db.prepare("SELECT 1 FROM events WHERE id = ? AND ingest_version NOT LIKE 'seed-%'");
    const missing = missingPromotions(rows, qid => Boolean(find.get(qid)));
    const review = reviewFallbacks(missing, exceptions as FallbackException[], eligibleQids);
    console.log(JSON.stringify({ db: dbPath, strict, ...review, note: 'Read-only; unreviewed absence is not proof of an error.' }, null, 2));
    if (strict && review.unreviewed.length > 0) process.exitCode = 1;
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
