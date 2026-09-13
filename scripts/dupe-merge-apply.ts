/**
 * dupe-merge-apply.ts - applies the automatic co-located merge plan.
 *
 *   npx tsx scripts/dupe-merge-apply.ts            -> dry run, writes nothing
 *   npx tsx scripts/dupe-merge-apply.ts --apply    -> writes
 *
 * The plan comes from scripts/lib/dupe-plan.ts, the same code that printed
 * the reviewed MERGE TSV, so what is applied is what was reviewed. The group
 * ids (M001...) match that TSV as long as the dataset has not changed
 * underneath; --expect-groups asserts the count so a changed dataset fails
 * loudly instead of merging a plan nobody read.
 *
 * Rows in the HELD, REVIEW and APART buckets are NOT touched here. HELD and
 * REVIEW pairs are decided by hand in the Notion review table and applied by
 * scripts/dupe-merge-manual.ts.
 *
 * Order matters: run this first, then dupe-merge-manual.ts. Both are
 * idempotent and both refuse to delete a row the other keeps, so the reverse
 * order is safe too, it is just noisier.
 */
import Database from 'better-sqlite3'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	type MergeSpec,
	applyMerges,
	backupDb,
	pruneSeedJson,
	reportResult,
} from './lib/dupe-apply.js'
import { CO_LOCATED_KM, buildPlan, electGroup, findDb, loadRows } from './lib/dupe-plan.js'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')

// --expect-groups takes a value. Parse it BEFORE looking for the optional
// positional db path, otherwise `--expect-groups 132` hands "132" to findDb
// and the run dies with "No file at <repo>\132" before planning anything.
const inlineExpect = argv.find((a) => a.startsWith('--expect-groups='))
const expectIndex = argv.indexOf('--expect-groups')
const expectRaw = inlineExpect
	? inlineExpect.slice('--expect-groups='.length)
	: expectIndex !== -1
		? argv[expectIndex + 1]
		: undefined

let EXPECT_GROUPS: number | undefined
if (expectRaw !== undefined) {
	EXPECT_GROUPS = Number(expectRaw)
	if (!Number.isInteger(EXPECT_GROUPS) || EXPECT_GROUPS < 0) {
		console.error('ABORT: --expect-groups needs a whole number, got: ' + String(expectRaw))
		process.exit(1)
	}
}

// The value that follows a bare `--expect-groups` is consumed by the flag and
// must never be read as the db path.
const consumedIndex = inlineExpect === undefined && expectIndex !== -1 ? expectIndex + 1 : -1
const pathArg = argv.find((a, i) => !a.startsWith('--') && i !== consumedIndex)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = findDb(pathArg)

console.log('db: ' + dbPath)
console.log(APPLY ? 'APPLY MODE - the database and seed JSON will be written.\n' : 'DRY RUN - nothing will be written.\n')

// Plan against a read-only handle first, so a bad plan never opens a writer.
const planDb = new Database(dbPath, { readonly: true })
const { rows, siblings } = loadRows(planDb)
const plan = buildPlan(rows)
planDb.close()

console.log('rows in scope: ' + rows.length + ' (excluded ' + siblings.length + ' participant-sibling rows)')
console.log('merge groups planned: ' + plan.groupList.length + ' (co-located within ' + CO_LOCATED_KM + 'km)')

if (EXPECT_GROUPS !== undefined && EXPECT_GROUPS !== plan.groupList.length) {
	console.error(
		'\nABORT: expected ' +
			EXPECT_GROUPS +
			' merge groups but the planner produced ' +
			plan.groupList.length +
			'.\nThe dataset changed since the plan was reviewed. Re-run dupe-merge-plan.ts and re-read it.',
	)
	process.exit(1)
}

const specs: MergeSpec[] = plan.groupList.map((grp, i) => {
	const e = electGroup(grp.members)
	return {
		id: 'M' + String(i + 1).padStart(3, '0'),
		memberIds: grp.members.map((r) => r.id),
		// No pin: the automatic election already prefers a universal id and a
		// non-seed title, which is what the reviewed TSV shows.
		note: [...grp.rules].sort().join('+') + ' ' + grp.maxKm.toFixed(1) + 'km, survivor ' + e.idFrom.id,
	}
})

if (APPLY) {
	const backup = backupDb(dbPath)
	console.log('backup written: ' + backup + '\n')
}

const db = new Database(dbPath)
try {
	if (APPLY) db.pragma('journal_mode = WAL')
	else db.pragma('query_only = ON')

	const before = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c

	console.log('================ AUTOMATIC MERGES ================')
	const result = applyMerges(db, specs, {
		apply: APPLY,
		dbPath,
		repoRoot,
		metaKey: 'last_auto_dupe_merge',
		label: 'automatic co-located merge',
	})

	pruneSeedJson(repoRoot, result.deletedSeedIds, APPLY)
	reportResult(result, APPLY)

	const after = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c
	console.log('\n  events rows: ' + before + ' -> ' + after + ' (' + (after - before) + ')')
	if (APPLY) {
		console.log('  Next: npx tsx scripts/dupe-merge-manual.ts --apply')
	}
} finally {
	db.close()
}
