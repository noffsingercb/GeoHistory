/**
 * dupe-merge-plan.ts - read-only merge planner. v3.2.
 *
 * Run from the repo root:
 *   npx tsx scripts/dupe-merge-plan.ts
 *   npx tsx scripts/dupe-merge-plan.ts C:\\path\\to\\events.sqlite
 *
 * v3.2 moves the planning logic into scripts/lib/dupe-plan.ts unchanged and
 * leaves this file as the printer. The reason is that the applier now exists:
 * a plan that is reviewed and a plan that is applied must come from the same
 * code, or the review approves one thing and the write performs another. The
 * output of this script is identical to v3.1's.
 *
 * Read-only. Opens the DB with readonly: true and issues no writes. The
 * output is a plan to be reviewed, not an applied change.
 */
import Database from 'better-sqlite3'
import {
	CO_LOCATED_KM,
	DENYLIST,
	REVIEW_KM,
	buildPlan,
	electGroup,
	findDb,
	fmt,
	loadRows,
	titleOf,
	yearOf,
} from './lib/dupe-plan.js'

const MAX_REVIEW_LINES = 60
const MAX_HELD_LINES = 40

const dbPath = findDb(process.argv[2])
const db = new Database(dbPath, { readonly: true })
console.log('db: ' + dbPath)
console.log('co-located <= ' + CO_LOCATED_KM + 'km | review <= ' + REVIEW_KM + 'km | apart > ' + REVIEW_KM + 'km')

const { rows, siblings, noCoords } = loadRows(db)
console.log('rows in scope: ' + rows.length + ' (excluded ' + siblings.length + ' participant-sibling rows)')
if (noCoords > 0) console.log('rows without coordinates: ' + noCoords + ' (these can never be gated; they go to REVIEW)')

const plan = buildPlan(rows)

console.log('\n================ MERGE PLAN (co-located) ================')
console.log('These passed the coordinate gate. One line per merge GROUP, not per pair.')
console.log('Paste between the markers.\n')
console.log('--- BEGIN MERGE TSV ---')
console.log(
	[
		'id',
		'rule',
		'year',
		'max_km',
		'rows',
		'survivor_id',
		'survivor_title',
		'survivor_date',
		'survivor_scope',
		'survivor_score',
		'blurb_from',
		'deleted_rows',
	].join('\t'),
)
let m = 0
for (const grp of plan.groupList) {
	m++
	const e = electGroup(grp.members)
	const losers = grp.members.filter((r) => r.id !== e.idFrom.id).map((r) => r.id)
	console.log(
		[
			'M' + String(m).padStart(3, '0'),
			[...grp.rules].sort().join('+'),
			yearOf(e.dateFrom),
			grp.maxKm.toFixed(1),
			grp.members.length,
			e.idFrom.id,
			titleOf(e.titleFrom),
			e.dateFrom.date_start + (e.endFrom.date_end ? ' -> ' + e.endFrom.date_end : ''),
			e.scopeFrom.scope,
			Number(e.scoreFrom.significance).toFixed(3),
			e.blurbFrom.id,
			losers.join(','),
		].join('\t'),
	)
}
console.log('--- END MERGE TSV ---')

if (plan.multiRowGroups.length > 0) {
	console.log('\n  groups with more than two rows (these are the ones v3 got wrong):')
	for (const grp of plan.multiRowGroups) {
		const e = electGroup(grp.members)
		console.log('    ' + e.idFrom.id + ' <- ' + grp.members.map((r) => r.id).join(' + '))
	}
}

console.log('\n================ HELD (co-located but not auto-merged) ================')
console.log('These look like duplicates and sit close together, but a structural')
console.log('reason says do not merge them automatically. Hand review only.\n')
for (const g of plan.helds.slice(0, MAX_HELD_LINES)) {
	console.log([g.rule, yearOf(g.a), g.km == null ? 'no-coords' : g.km.toFixed(1) + 'km', g.hold].join('\t'))
	console.log('    ' + fmt(g.a))
	console.log('    ' + fmt(g.b))
}
if (plan.helds.length > MAX_HELD_LINES) console.log('  ... and ' + (plan.helds.length - MAX_HELD_LINES) + ' more')

console.log('\n================ REVIEW (borderline distance) ================')
console.log('Between ' + CO_LOCATED_KM + 'km and ' + REVIEW_KM + 'km, or missing coordinates.\n')
for (const g of plan.reviews.slice(0, MAX_REVIEW_LINES)) {
	console.log(
		[g.rule, yearOf(g.a), g.km == null ? 'no-coords' : g.km.toFixed(1) + 'km', fmt(g.a), fmt(g.b), g.note]
			.filter(Boolean)
			.join('\t'),
	)
}
if (plan.reviews.length > MAX_REVIEW_LINES) {
	console.log('  ... and ' + (plan.reviews.length - MAX_REVIEW_LINES) + ' more')
}

console.log('\n================ APART (rejected, different places) ================')
const apartByRule = new Map<string, number>()
for (const g of plan.aparts) apartByRule.set(g.rule, (apartByRule.get(g.rule) || 0) + 1)
for (const [rule, c] of apartByRule) console.log('  ' + rule + ': ' + c)
const farthest = [...plan.aparts].sort((x, y) => (y.km || 0) - (x.km || 0)).slice(0, 10)
console.log('  farthest 10, as a sanity check that the gate is rejecting the right things:')
for (const g of farthest) {
	console.log('    ' + (g.km || 0).toFixed(0) + 'km  ' + titleOf(g.a) + '  <->  ' + titleOf(g.b))
}

console.log('\n================ SUMMARY ================')
console.log('  MERGE  groups planned:        ' + plan.groupList.length)
console.log('  MERGE  rows they consume:     ' + plan.groupList.reduce((n, g) => n + g.members.length, 0))
console.log('  MERGE  groups over two rows:  ' + plan.multiRowGroups.length)
console.log('  HELD   (co-located, hand):    ' + plan.helds.length)
console.log('  REVIEW (borderline):          ' + plan.reviews.length)
console.log('  APART  (rejected by gate):    ' + plan.aparts.length)
console.log('  candidates generated:         ' + plan.graded.length)
console.log('  parent/child appended titles rejected silently: ' + plan.rejectedAppend)
console.log('  hand-verified non-duplicates denylisted:        ' + plan.rejectedDeny + ' of ' + DENYLIST.size)
console.log('  participant-sibling rows excluded from scope:   ' + siblings.length)
console.log('\n  Read-only. Nothing was written. The MERGE block is a proposal.')

db.close()
