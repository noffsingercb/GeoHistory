/**
 * probe-dupes.ts - read-only duplicate census for core DB v0.6.
 *
 * Run from the repo root:
 *   npx tsx scripts/probe-dupes.ts
 *   npx tsx scripts/probe-dupes.ts C:\\path\\to\\events.sqlite
 *
 * Answers two questions:
 *   A. How many curated universal rows still have a live dump twin?
 *      Split by id family: 'universal:*' slugs (inserted, twin survives)
 *      vs 'Q*' promotes (in-place, should have no twin).
 *   B. How big is the year-narrative family that titles rows after a place?
 *
 * Read-only. Opens the DB with readonly: true and issues no writes.
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

type Row = Record<string, any>

const CANDIDATES = [
	'events.sqlite',
	'data/events.sqlite',
	'db/events.sqlite',
	'geohistory.sqlite',
]

function findDb(): string {
	const explicit = process.argv[2]
	if (explicit) {
		const p = resolve(process.cwd(), explicit)
		if (!existsSync(p)) {
			console.error('No file at ' + p)
			process.exit(1)
		}
		return p
	}
	for (const c of CANDIDATES) {
		const p = resolve(process.cwd(), c)
		if (existsSync(p)) return p
	}
	console.error('No DB found. Tried:')
	for (const c of CANDIDATES) console.error('  ' + resolve(process.cwd(), c))
	console.error('Pass the path explicitly: npx tsx scripts/probe-dupes.ts <path.sqlite>')
	process.exit(1)
}

const dbPath = findDb()
const db = new Database(dbPath, { readonly: true })
console.log('db: ' + dbPath)

const titleOf = (r: Row) => String(r.display_title || r.title || '')

/** Strip a trailing phase word and any parenthetical qualifier. */
function normalize(s: string): string {
	return s
		.replace(/\s*[-\u2013\u2014]\s*(begins?|ends?|began|ended)\s*$/i, '')
		.replace(/\s*\([^)]*\)\s*$/, '')
		.trim()
}

// ---------------------------------------------------------------- section A
console.log('\n================ A. clusters from the 1725-1790 print ================')

const clusterQ = db.prepare(
	'SELECT id, scope, category, title, display_title, date_start, date_end, significance ' +
		'FROM events ' +
		'WHERE title LIKE ? OR COALESCE(display_title, \'\') LIKE ? OR COALESCE(blurb, \'\') LIKE ? ' +
		'ORDER BY significance DESC LIMIT 12',
)

const PATTERNS = [
	'Seven Years',
	'French and Indian',
	'American Revolution',
	'Treaty of Paris',
	'French Revolution',
	'Polish Succession',
	'Aix-la-Chapelle',
]

for (const p of PATTERNS) {
	const like = '%' + p + '%'
	const rows = clusterQ.all(like, like, like) as Row[]
	console.log('\n--- ' + p + ' (' + rows.length + ' shown, top 12 by significance) ---')
	for (const r of rows) {
		console.log(
			'  ' +
				[
					r.id,
					r.scope,
					r.category,
					r.date_start,
					r.date_end || '-',
					Number(r.significance).toFixed(3),
					titleOf(r),
				].join(' | '),
		)
	}
}

// ---------------------------------------------------------------- section B
console.log('\n================ B. universal rows with a surviving dump twin ================')

const universals = db
	.prepare('SELECT id, title, display_title, date_start, date_end FROM events WHERE scope = \'universal\' ORDER BY date_start')
	.all() as Row[]

const twinQ = db.prepare(
	'SELECT id, scope, category, date_start, date_end, title, display_title, significance ' +
		'FROM events ' +
		'WHERE scope <> \'universal\' ' +
		'  AND id <> ? ' +
		'  AND ( LOWER(COALESCE(display_title, title)) = LOWER(?) ' +
		'     OR LOWER(COALESCE(display_title, title)) LIKE ? ' +
		'     OR LOWER(COALESCE(blurb, \'\')) LIKE ? ) ' +
		'ORDER BY significance DESC LIMIT 5',
)

let slugTotal = 0
let qidTotal = 0
let slugWithTwin = 0
let qidWithTwin = 0

for (const u of universals) {
	const isSlug = String(u.id).startsWith('universal:')
	if (isSlug) slugTotal++
	else qidTotal++

	const name = normalize(titleOf(u))
	if (name.length < 5) {
		console.log('\n  [skipped: title too short to match safely] ' + u.id + ' "' + name + '"')
		continue
	}
	const lower = name.toLowerCase()
	const hits = twinQ.all(u.id, name, '%' + lower + '%', '%' + lower + '%') as Row[]
	if (hits.length === 0) continue

	if (isSlug) slugWithTwin++
	else qidWithTwin++

	console.log('\n  ' + (isSlug ? 'SLUG' : 'QID ') + '  ' + u.id + '  "' + name + '"  ' + u.date_start)
	for (const h of hits) {
		console.log(
			'      twin <- ' +
				[h.id, h.scope, h.category, h.date_start, h.date_end || '-', Number(h.significance).toFixed(3), titleOf(h)].join(' | '),
		)
	}
}

// ---------------------------------------------------------------- section C
console.log('\n================ C. the year-narrative family ================')

for (const r of db
	.prepare(
		'SELECT category, COUNT(*) AS n, SUM(CASE WHEN display_title IS NULL OR TRIM(display_title) = \'\' THEN 1 ELSE 0 END) AS no_display_title ' +
			'FROM events WHERE category IN (\'event\', \'milestone\') GROUP BY category ORDER BY n DESC',
	)
	.all() as Row[]) {
	console.log('  ' + r.category + ': ' + r.n + ' rows, ' + r.no_display_title + ' without display_title')
}

console.log('\n  sample, category = event, 1700-1799, top 12 by significance:')
for (const r of db
	.prepare(
		'SELECT id, date_start, title, display_title, substr(COALESCE(blurb, \'\'), 1, 80) AS blurb ' +
			'FROM events WHERE category = \'event\' AND date_start >= \'1700\' AND date_start < \'1800\' ' +
			'ORDER BY significance DESC LIMIT 12',
	)
	.all() as Row[]) {
	console.log('  ' + [r.id, r.date_start, 'title="' + r.title + '"', 'display="' + (r.display_title || '-') + '"', r.blurb].join(' | '))
}

// ---------------------------------------------------------------- summary
console.log('\n================ SUMMARY ================')
console.log('  universal rows: ' + universals.length + ' (' + slugTotal + ' slug, ' + qidTotal + ' QID)')
console.log('  slug rows with a surviving dump twin: ' + slugWithTwin + ' / ' + slugTotal)
console.log('  QID  rows with a surviving dump twin: ' + qidWithTwin + ' / ' + qidTotal + '   (expect 0)')
console.log('\n  Candidate matches above are NOT proof of identity - blurb mentions')
console.log('  are noisy. Read the twin list before any pass deletes anything.')

db.close()
