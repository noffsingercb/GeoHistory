/**
 * verify-dedupe.ts - read-only check that the dedupe pass did what we think.
 *
 *   npx tsx scripts/verify-dedupe.ts
 *
 * Nothing here writes. It answers five questions:
 *   1. did the version stamp actually land?
 *   2. is the universal tier still 34 rows?
 *   3. are the four duplicates Ben reported from the live timeline gone?
 *   4. did a sample of donor ids disappear while their survivors remain?
 *   5. does events_fts still agree with events after 196 deletes?
 */
import Database from 'better-sqlite3'
import { findDb } from './lib/dupe-plan.js'

const dbPath = findDb(process.argv.slice(2).find((a) => !a.startsWith('--')))
console.log('db: ' + dbPath + '\n')

const db = new Database(dbPath, { readonly: true })
db.pragma('query_only = ON')

let failures = 0
const check = (label: string, ok: boolean, detail: string) => {
	if (!ok) failures++
	console.log((ok ? '  PASS  ' : '  FAIL  ') + label + ' -- ' + detail)
}

const meta = (key: string): string => {
	const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
	return r ? r.value : '(absent)'
}

console.log('================ 1. STAMP ================')
const version = meta('dataset_version')
check('dataset_version bumped', version === 'dump-v0.6.1', version)
check('previous version recorded', meta('dataset_version_previous') === 'dump-v0.6', meta('dataset_version_previous'))
console.log('  dataset_row_count = ' + meta('dataset_row_count'))
console.log('  dedupe_pass       = ' + meta('dedupe_pass'))
console.log('  last_auto_dupe_merge   = ' + meta('last_auto_dupe_merge'))
console.log('  last_manual_dupe_merge = ' + meta('last_manual_dupe_merge'))

console.log('\n================ 2. COUNTS ================')
const total = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c
const universal = (db.prepare("SELECT COUNT(*) AS c FROM events WHERE scope = 'universal'").get() as { c: number }).c
check('total rows', total === 116099, String(total))
check('universal tier intact', universal === 34, String(universal) + ' rows')
check('row_count stamp matches table', meta('dataset_row_count') === String(total), meta('dataset_row_count'))

console.log('\n================ 3. THE FOUR REPORTED DUPES ================')
// Each entry: a label, and the LIKE patterns that should now resolve to the
// stated number of surviving rows.
const reported: Array<{ label: string; sql: string; params: string[]; expect: number }> = [
	{
		label: 'Treaty of Paris 1783 (was 2 tiles: "Paris" + "Treaty of Paris")',
		sql: "SELECT id, display_title, date_start, scope FROM events WHERE date_start LIKE '1783%' AND (lower(display_title) = 'paris' OR lower(display_title) LIKE 'treaty of paris%')",
		params: [],
		expect: 1,
	},
	{
		label: 'Treaty of Paris 1763 (was 2 tiles: "Paris" + the 1763 treaty)',
		sql: "SELECT id, display_title, date_start, scope FROM events WHERE date_start LIKE '1763%' AND (lower(display_title) = 'paris' OR lower(display_title) LIKE 'treaty of paris%')",
		params: [],
		expect: 1,
	},
	{
		label: 'French and Indian War 1754 (was "North America" + the war)',
		sql: "SELECT id, display_title, date_start, scope FROM events WHERE date_start LIKE '1754%' AND (lower(display_title) = 'north america' OR lower(display_title) LIKE '%french and indian%')",
		params: [],
		expect: 1,
	},
	{
		label: 'American Revolutionary War (universal row survives)',
		sql: "SELECT id, display_title, date_start, scope FROM events WHERE id IN ('Q40949','seed:thirteen-colonies-1775-01-01')",
		params: [],
		expect: 1,
	},
]
for (const r of reported) {
	const rows = db.prepare(r.sql).all(...r.params) as Array<Record<string, unknown>>
	check(r.label, rows.length === r.expect, rows.length + ' row(s), expected ' + r.expect)
	for (const row of rows) {
		console.log('          ' + [row.id, row.display_title, row.date_start, row.scope].join(' | '))
	}
}

console.log('\n================ 4. DONOR / SURVIVOR SPOT CHECK ================')
// survivor that must exist  <-  donor that must be gone
const pairs: Array<[string, string]> = [
	['Q8736', 'seed:versailles-1919-06-28'],
	['Q6534', 'seed:france-1789-01-01'],
	['Q217450', 'seed:paris-1783-01-01'],
	['Q156211', 'seed:paris-1763-01-01'],
	['Q154697', 'seed:north-america-1754-01-01'],
	['universal:atomic-bombings-of-hiroshima-and-nagasaki', 'Q488'],
	['universal:fall-of-the-berlin-wall', 'Q69163529'],
	['universal:eruption-of-krakatoa', 'Q8094772'],
	['Q243590', 'seed:sikh-empire-1848-01-01'],
	['Q16335075', 'seed:debaltseve-2015-02-20'],
]
const exists = db.prepare('SELECT COUNT(*) AS c FROM events WHERE id = ?')
for (const [survivor, donor] of pairs) {
	const s = (exists.get(survivor) as { c: number }).c
	const d = (exists.get(donor) as { c: number }).c
	check(survivor + ' <- ' + donor, s === 1 && d === 0, 'survivor ' + s + ', donor ' + d)
}

console.log('\n================ 5. FTS INTEGRITY ================')
try {
	const ftsCount = (db.prepare('SELECT COUNT(*) AS c FROM events_fts').get() as { c: number }).c
	check('events_fts row count matches events', ftsCount === total, ftsCount + ' vs ' + total)
	const hit = db
		.prepare("SELECT COUNT(*) AS c FROM events_fts WHERE events_fts MATCH 'revolution'")
		.get() as { c: number }
	check('FTS query still returns hits', hit.c > 0, hit.c + " matches for 'revolution'")
} catch (err) {
	check('events_fts readable', false, String(err))
}

console.log('\n================ RESULT ================')
console.log(failures === 0 ? 'All checks passed.' : failures + ' CHECK(S) FAILED - do not dump until these are understood.')
db.close()
process.exit(failures === 0 ? 0 : 1)
