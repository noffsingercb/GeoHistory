/**
 * probe-american-revolution.ts - which row is the 1763 tile?
 *
 * Read-only. Nothing here writes, so it is safe to run against the live
 * events.sqlite.
 *
 * The question this answers: the "American Revolution" card dated 1763 is
 * either
 *
 *   (a) Q40949, the universal row. Wikidata dates the political revolution
 *       from the end of the Seven Years' War, so 1763 is its real start
 *       time and not a data error. This row is one of the 34 universal rows
 *       that now ALWAYS draw, so deleting it removes the American Revolution
 *       from every timeline in the corpus.
 *
 *   (b) some other row - a seed row, a narrative row, or a participant
 *       sibling - which can be deleted with no such consequence.
 *
 * The fix differs completely between those two cases, which is why this runs
 * before anything is removed.
 *
 * Usage:  npx tsx scripts/probe-american-revolution.ts
 */
import Database from 'better-sqlite3'
import { findDb, ROW_COLUMNS, fmt, isUniversal, type Row } from './lib/dupe-plan'

const dbPath = findDb(process.argv[2])
const db = new Database(dbPath, { readonly: true })
// The dataset is built with SQLITE_DQS=0, so every string literal below is
// single-quoted. A double-quoted literal would be read as an identifier.
db.pragma('query_only = 1')

console.log('db: ' + dbPath)
console.log('')

const all = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Row[]

// ---------------------------------------------------------------- section A
// Everything in the corpus that names a revolution anywhere near the period.
// Deliberately wide: title, display_title AND blurb, 1750-1800. A narrow
// query is how you conclude a row does not exist when it is titled something
// you did not predict.
console.log('=== A. rows naming "revolution" or "american", 1750-1800 ===')
const near = all(
	'SELECT ' +
		ROW_COLUMNS +
		' FROM events WHERE (' +
		"  lower(title) LIKE '%revolution%' OR lower(display_title) LIKE '%revolution%'" +
		"  OR lower(blurb) LIKE '%american revolution%'" +
		') AND date_start >= ? AND date_start < ? ORDER BY date_start',
	'1750',
	'1801',
)
for (const r of near) console.log('  ' + fmt(r) + (isUniversal(r) ? '   <-- UNIVERSAL' : ''))
console.log('  count: ' + near.length)
console.log('')

// ---------------------------------------------------------------- section B
// The two named candidates, by id, whether or not section A found them.
console.log('=== B. the two known ids ===')
for (const id of ['Q40949', 'Q192769']) {
	const rows = all('SELECT ' + ROW_COLUMNS + ' FROM events WHERE id = ?', id)
	if (rows.length === 0) {
		console.log('  ' + id + ' *** NOT PRESENT ***')
		continue
	}
	for (const r of rows) {
		console.log('  ' + fmt(r) + (isUniversal(r) ? '   <-- UNIVERSAL' : ''))
		console.log('      blurb: ' + String(r.blurb || '(none)').slice(0, 160))
	}
}
console.log('')

// ---------------------------------------------------------------- section C
// Anything dated in 1763 that could plausibly be the tile, regardless of what
// it is called. If the offending row is titled "American Revolution" but
// carries an id nobody guessed, this is where it shows up.
console.log('=== C. every row dated 1763 with significance >= 0.55 ===')
const y1763 = all(
	'SELECT ' +
		ROW_COLUMNS +
		' FROM events WHERE date_start >= ? AND date_start < ? AND significance >= 0.55 ' +
		"AND category <> 'founding' ORDER BY significance DESC",
	'1763',
	'1764',
)
for (const r of y1763) console.log('  ' + fmt(r) + (isUniversal(r) ? '   <-- UNIVERSAL' : ''))
console.log('  count: ' + y1763.length)
console.log('')

// ---------------------------------------------------------------- section D
// Participant siblings. A sibling id is the parent id plus '#' plus a
// participant QID. Deleting a parent while its children remain leaves rows
// that reference an event that no longer exists.
console.log('=== D. participant siblings of the candidates ===')
for (const id of ['Q40949', 'Q192769']) {
	const kids = all('SELECT ' + ROW_COLUMNS + ' FROM events WHERE id LIKE ?', id + '#%')
	console.log('  ' + id + ': ' + kids.length + ' sibling(s)')
	for (const k of kids) console.log('      ' + fmt(k))
}
console.log('')

// ---------------------------------------------------------------- section E
// What a 1725-1790 life would actually be shown, so the effect of a deletion
// can be predicted rather than discovered after a re-release. Mirrors the
// fixture that surfaced the complaint.
console.log('=== E. universal rows overlapping 1725-1790 ===')
const universals = all(
	'SELECT ' +
		ROW_COLUMNS +
		" FROM events WHERE (scope = 'universal' OR id LIKE 'universal:%') " +
		'AND date_start < ? AND (date_end IS NULL OR date_end >= ?) ORDER BY date_start',
	'1791',
	'1725',
)
for (const r of universals) console.log('  ' + fmt(r))
console.log('  count: ' + universals.length)
console.log('')

console.log('total events: ' + (db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n)
db.close()
