/**
 * dupe-merge-manual.ts - applies the hand verdicts from the Notion review
 * table "Duplicate pair review - dump-v0.6".
 *
 *   npx tsx scripts/dupe-merge-manual.ts            -> dry run
 *   npx tsx scripts/dupe-merge-manual.ts --apply    -> writes
 *
 * Every entry below is a row of that table with Merge? = Y, transcribed with
 * its Survivor note honoured literally. The Survivor note is the whole point
 * of the table: several clusters were flagged Y but the note narrows the
 * merge to one pair inside the cluster, and two were flagged Y with a note
 * that says not to merge at all. Those narrowings are encoded here, so this
 * file is the audit trail. Do not widen an entry without changing the table.
 *
 * Not encoded here, on purpose:
 *   - G006 Peace of Westphalia and G018 Treaty of Turin: flagged Y, but the
 *     Survivor note reads "none; no merge". Listed as NO_MERGE below so the
 *     decision is visible rather than missing.
 *   - P007 American Revolution: the fix is a curated supersedes entry for
 *     Q192769, not a row merge. A separate change to the universal seed.
 *   - G011's two Nassau rows: kept, and retitled by a separate pass.
 *   - G003's two Puerto Rico rows: the note keeps "a row for PR" but the
 *     cluster holds two, so which one survives is still open. Left alone.
 *   - P004 Year Without a Summer: merged, but the note only "considers"
 *     moving the display date to 1816. Date left untouched; that is a
 *     display-date decision, not a merge decision.
 */
import Database from 'better-sqlite3'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMerges, backupDb, pruneSeedJson, reportResult } from './lib/dupe-apply.js'
import { NO_MERGE, VERDICTS } from './lib/reviewed-dupe-verdicts.js'
import { findDb } from './lib/dupe-plan.js'


const APPLY = process.argv.includes('--apply')
const pathArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = findDb(pathArg)

console.log('db: ' + dbPath)
console.log(APPLY ? 'APPLY MODE - the database and seed JSON will be written.\n' : 'DRY RUN - nothing will be written.\n')
console.log('hand verdicts to apply: ' + VERDICTS.length)
console.log('flagged Y but recorded as "no merge": ' + NO_MERGE.length)
for (const n of NO_MERGE) console.log('  ' + n.id + ': ' + n.why)

// A survivor must never appear as a casualty of another verdict. Catch that
// here, before a writer is opened, rather than relying on the runtime guard.
const survivorIds = new Set(VERDICTS.map((v) => v.survivorId).filter((id): id is string => Boolean(id)))
const conflicts: string[] = []
for (const v of VERDICTS) {
	for (const id of v.memberIds) {
		if (id !== v.survivorId && survivorIds.has(id)) {
			conflicts.push(v.id + ' would delete ' + id + ', which survives another verdict')
		}
	}
}
if (conflicts.length > 0) {
	console.error('\nABORT: contradictory verdicts; nothing was written:')
	for (const c of conflicts) console.error('  - ' + c)
	process.exit(1)
}

if (APPLY) {
	const backup = backupDb(dbPath)
	console.log('\nbackup written: ' + backup)
}

const db = new Database(dbPath)
try {
	if (APPLY) db.pragma('journal_mode = WAL')
	else db.pragma('query_only = ON')

	const before = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c

	console.log('\n================ HAND VERDICTS ================')
	const result = applyMerges(db, VERDICTS, {
		apply: APPLY,
		dbPath,
		repoRoot,
		metaKey: 'last_manual_dupe_merge',
		label: 'hand-reviewed merge',
	})

	pruneSeedJson(repoRoot, result.deletedSeedIds, APPLY)
	reportResult(result, APPLY)

	const after = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c
	console.log('\n  events rows: ' + before + ' -> ' + after + ' (' + (after - before) + ')')
	if (APPLY) console.log('  Next: npx tsx scripts/dataset-stamp.ts --apply --version <dump-vX.Y>')
} finally {
	db.close()
}
