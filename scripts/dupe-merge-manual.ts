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
import { type MergeSpec, applyMerges, backupDb, pruneSeedJson, reportResult } from './lib/dupe-apply.js'
import { findDb } from './lib/dupe-plan.js'

/** Flagged Y, but the Survivor note says do not merge. Recorded, not applied. */
const NO_MERGE: Array<{ id: string; why: string }> = [
	{ id: 'G006', why: 'Peace of Westphalia: "none; no merge" - all four clause rows stand' },
	{ id: 'G018', why: 'Treaty of Turin: "none; no merge" - Nice and Savoy both stand' },
]

const VERDICTS: MergeSpec[] = [
	// ---------------------------------------------------------------- clusters
	// Each of these was flagged Y with a note naming ONE pair inside a larger
	// cluster. The clause rows that give a treaty its territorial detail stay.
	{
		id: 'G001',
		survivorId: 'Q8736',
		memberIds: ['Q8736', 'seed:versailles-1919-06-28'],
		note: 'Versailles pair only; the six clause rows stand alone',
	},
	{
		id: 'G003',
		survivorId: 'Q12583',
		memberIds: ['Q12583', 'seed:spain-1898-01-01', 'seed:island-of-guam-1898-12-10'],
		note: 'keeps a row for Cuba and the Philippines; the PR duplicate is still open',
	},
	{
		id: 'G004',
		survivorId: 'Q192924',
		memberIds: ['Q192924', 'seed:saint-germain-en-laye-1919-09-10'],
		note: 'co-located pair only',
	},
	{
		id: 'G005',
		survivorId: 'Q49100',
		memberIds: ['Q49100', 'seed:israel-and-arab-states-1973-10-06'],
		note: 'first pair only; Sinai, Suez and Golan rows stand',
	},
	{
		id: 'G009',
		survivorId: 'Q269267',
		memberIds: ['Q269267', 'seed:neuilly-sur-seine-1919-11-27'],
		note: 'co-located pair only',
	},
	{
		id: 'G010',
		survivorId: 'Q351722',
		memberIds: ['Q351722', 'seed:spanish-and-american-north-america-1821-02-19'],
		note: 'Adams-Onis title, seed score 0.938; the two Florida rows stand',
	},
	{
		id: 'G011',
		survivorId: 'Q40949',
		memberIds: ['Q40949', 'seed:thirteen-colonies-1775-01-01'],
		note: 'universal row survives; both Nassau rows kept for a separate retitle',
	},
	{
		id: 'G014',
		survivorId: 'Q11821309',
		memberIds: ['Q11821309', 'seed:serbia-banat-and-northern-bosnia-1739-09-18'],
		note: '"Q11821309 if you say merge"; Oltenia clause row stands',
	},
	{
		id: 'G015',
		survivorId: 'Q156086',
		memberIds: ['Q156086', 'seed:aix-la-chapelle-1748-01-01'],
		note: 'also reached by the automatic plan; Parma clause row stands',
	},
	{
		id: 'G016',
		survivorId: 'Q462964',
		memberIds: ['Q462964', 'seed:poland-1830-01-01', 'seed:battle-of-warsaw-1831-09-06'],
		note: 'both seed rows, score 0.927',
	},
	{
		id: 'G017',
		survivorId: 'Q243590',
		memberIds: ['Q243590', 'seed:sikh-empire-1848-01-01', 'seed:sikh-empire-1849-03-29'],
		note: 'same place, war start and war end encoded as two points; score 0.945',
	},
	{
		id: 'G019',
		survivorId: 'Q46083',
		memberIds: ['Q46083', 'seed:second-french-empire-1870-01-01'],
		note: 'first pair only; the 1871 Alsace-Lorraine treaty row stands',
	},
	{
		id: 'G021',
		survivorId: 'Q152004',
		memberIds: ['Q152004', 'seed:andean-territory-1879-01-01', 'seed:antofagasta-1879-02-14'],
		note: 'both seed rows sit on identical coordinates; score 0.957',
	},
	{
		id: 'G022',
		survivorId: 'Q498979',
		memberIds: ['Q498979', 'seed:panama-canal-zone-1903-11-18', 'seed:panama-canal-zone-1904-05-04'],
		note: 'three rows, one identical title -> one row at 1903-11-18, score 0.989',
	},
	{
		id: 'G024',
		survivorId: 'Q223604',
		memberIds: ['Q223604', 'seed:greece-1940-10-28', 'seed:greece-1941-04-23'],
		note: 'same place, begin and end; score 0.943',
	},
	{
		id: 'G025',
		survivorId: 'Q696848',
		memberIds: ['Q696848', 'seed:iraq-1941-05-02', 'seed:iraq-1941-05-31'],
		note: 'same place, begin and end; score 0.883',
	},
	{
		// The only verdict where a seed row is the survivor: the note keeps the
		// earlier seed row and leaves the entity row untouched.
		id: 'G026',
		survivorId: 'seed:ecuador-peru-border-1941-07-05',
		memberIds: ['seed:ecuador-peru-border-1941-07-05', 'seed:ecuador-peru-border-1941-07-31'],
		note: 'one seed row at 1941-07-05; Q1500631 deliberately untouched',
	},
	{
		id: 'G027',
		survivorId: 'Q877399',
		memberIds: ['Q877399', 'seed:washington-d-c-1949-04-04', 'seed:nato-1949-08-24'],
		note: 'date 1949-04-04 comes from the seed row, score 0.975',
	},

	// ------------------------------------------------------------- hand pairs
	// P-rows: the universal slug always survives, so a curated row is never
	// renamed to a QID.
	{
		id: 'P001',
		survivorId: 'universal:atomic-bombings-of-hiroshima-and-nagasaki',
		memberIds: ['universal:atomic-bombings-of-hiroshima-and-nagasaki', 'Q488'],
		note: 'title case is better on the universal row',
	},
	{
		id: 'P002',
		survivorId: 'universal:fall-of-the-berlin-wall',
		memberIds: ['universal:fall-of-the-berlin-wall', 'Q69163529'],
	},
	{
		id: 'P003',
		survivorId: 'universal:dissolution-of-the-soviet-union',
		memberIds: ['universal:dissolution-of-the-soviet-union', 'Q5167679'],
	},
	{
		id: 'P004',
		survivorId: 'universal:year-without-a-summer',
		memberIds: ['universal:year-without-a-summer', 'Q209625'],
		note: 'date left at 1815-04-10; moving the display date to 1816 is a separate call',
	},
	{
		id: 'P005',
		survivorId: 'universal:eruption-of-krakatoa',
		memberIds: ['universal:eruption-of-krakatoa', 'Q8094772'],
		// The note explicitly asks for the donor's category.
		overrides: { category: 'disaster' },
		note: "takes category='disaster' from Q8094772",
	},
	{
		id: 'P006',
		survivorId: 'universal:on-the-origin-of-species',
		memberIds: ['universal:on-the-origin-of-species', 'seed:on-the-origin-of-species-1859-01-01'],
	},
	{
		id: 'P008',
		survivorId: 'Q217450',
		memberIds: ['Q217450', 'seed:paris-1783-01-01'],
		note: 'keeps "Treaty of Paris (1783)", takes the seed blurb and the higher score',
	},
	{
		id: 'P009',
		survivorId: 'Q156211',
		memberIds: ['Q156211', 'seed:paris-1763-01-01'],
	},
	{
		// P010 and R016 are the same pair from two passes of the table.
		id: 'P010/R016',
		survivorId: 'Q212658',
		memberIds: ['Q212658', 'seed:poland-1733-01-01'],
		note: 'named war with the real 1733-1735 span',
	},
	{
		id: 'P011',
		survivorId: 'Q156086',
		memberIds: ['Q156086', 'seed:aix-la-chapelle-1748-01-01'],
		note: 'same pair as G015; idempotent',
	},
	{
		id: 'P012',
		survivorId: 'Q154697',
		memberIds: ['Q154697', 'seed:north-america-1754-01-01'],
		note: 'French and Indian War survives the global-scope narrative row',
	},

	// R-rows: the borderline-distance queue. Every one was flagged Y. Where the
	// Survivor cell named a row, that row is pinned; where it was left blank the
	// named-event row survives, which is the rule the filled-in cells follow.
	{ id: 'R001', survivorId: 'Q209387', memberIds: ['Q209387', 'seed:ankara-1402-01-01'] },
	{ id: 'R002', survivorId: 'Q937255', memberIds: ['Q937255', 'seed:grunwald-1410-01-01'] },
	{ id: 'R003', survivorId: 'Q690291', memberIds: ['Q690291', 'seed:breadfield-1479-01-01'] },
	{ id: 'R004', survivorId: 'Q1628477', memberIds: ['Q1628477', 'seed:diu-1509-01-01'] },
	{ id: 'R005', survivorId: 'Q165425', memberIds: ['Q165425', 'seed:lepanto-1571-01-01'] },
	{ id: 'R006', survivorId: 'Q1430504', memberIds: ['Q1430504', 'seed:ulster-1607-01-01'] },
	{ id: 'R007', survivorId: 'Q932228', memberIds: ['Q932228', 'seed:moscow-1610-01-01'] },
	{ id: 'R010', survivorId: 'Q80330', memberIds: ['Q80330', 'seed:england-1642-01-01'] },
	{ id: 'R011', survivorId: 'Q641479', memberIds: ['Q641479', 'seed:ukraine-1648-01-01'] },
	{ id: 'R012', survivorId: 'Q681401', memberIds: ['Q681401', 'seed:st-gotthard-1664-01-01'] },
	{ id: 'R013', survivorId: 'Q916495', memberIds: ['Q916495', 'seed:north-sea-1665-01-01'] },
	{ id: 'R014', survivorId: 'Q25857', memberIds: ['Q25857', 'seed:spanish-netherlands-1667-01-01'] },
	{ id: 'R015', survivorId: 'Q2320981', memberIds: ['Q2320981', 'seed:derry-1688-01-01'] },
	{ id: 'R017', survivorId: 'Q677929', memberIds: ['Q677929', 'seed:toulon-1744-01-01'] },
	{ id: 'R018', survivorId: 'Q617321', memberIds: ['Q617321', 'seed:mysore-1766-01-01'] },
	{ id: 'R019', survivorId: 'Q18408564', memberIds: ['Q18408564', 'seed:crimea-1783-01-01'] },
	{
		id: 'R020',
		survivorId: 'Q6534',
		memberIds: ['Q6534', 'seed:france-1789-01-01'],
		note: 'universal French Revolution row survives',
	},
	{ id: 'R021', survivorId: 'Q207318', memberIds: ['Q207318', 'seed:europe-1792-01-01'] },
	{
		id: 'R022',
		survivorId: 'Q78994',
		memberIds: ['Q78994', 'seed:europe-1803-01-01'],
		note: 'universal Napoleonic Wars row survives',
	},
	{ id: 'R023', survivorId: 'Q152499', memberIds: ['Q152499', 'seed:spain-1808-01-01'] },
	{ id: 'R024', survivorId: 'Q617210', memberIds: ['Q617210', 'seed:maratha-confederacy-1817-01-01'] },
	{ id: 'R025', survivorId: 'Q2584439', memberIds: ['Q2584439', 'seed:greater-syria-1831-01-01'] },
	{ id: 'R026', survivorId: 'Q827212', memberIds: ['Q827212', 'seed:gadsden-purchase-1853-06-24'] },
	{ id: 'R027', survivorId: 'Q228284', memberIds: ['Q228284', 'seed:kingdom-of-the-two-sicilies-1860-05-11'] },
	{ id: 'R028', survivorId: 'Q153650', memberIds: ['Q153650', 'seed:german-confederation-1866-01-01'] },
	{ id: 'R029', survivorId: 'Q329203', memberIds: ['Q329203', 'seed:south-african-republic-1880-01-01'] },
	{ id: 'R030', survivorId: 'Q43378', memberIds: ['Q43378', 'seed:colombia-1899-01-01'] },
	{ id: 'R031', survivorId: 'Q192050', memberIds: ['Q192050', 'seed:serbia-1914-07-28'] },
	{
		id: 'R032',
		survivorId: 'Q178275',
		memberIds: ['Q178275', 'seed:spanish-flu-1918-01-01'],
		note: 'universal 1918 influenza pandemic row survives',
	},
	{ id: 'R033', survivorId: 'Q150812', memberIds: ['Q150812', 'seed:poland-1939-09-01'] },
	{ id: 'R034', survivorId: 'Q164348', memberIds: ['Q164348', 'seed:hungary-1956-06-23'] },
	{ id: 'R035', survivorId: 'Q204213', memberIds: ['Q204213', 'seed:romania-1989-12-28'] },
	{ id: 'R036', survivorId: 'Q459282', memberIds: ['Q459282', 'seed:panama-1990-01-31'] },
	{ id: 'R037', survivorId: 'Q56039', memberIds: ['Q56039', 'seed:east-germany-1990-09-24'] },
	{ id: 'R038', survivorId: 'Q178810', memberIds: ['Q178810', 'seed:syria-2011-03-15'] },
	{ id: 'R039', survivorId: 'Q16335075', memberIds: ['Q16335075', 'seed:debaltseve-2015-02-20'] },
	{ id: 'R041', survivorId: 'Q55153903', memberIds: ['Q55153903', 'seed:north-macedonia-2019-02-12'] },
]

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
