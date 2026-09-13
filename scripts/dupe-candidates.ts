/**
 * dupe-candidates.ts - read-only candidate generator for hand review. v2.
 *
 * Run from the repo root:
 *   npx tsx scripts/dupe-candidates.ts
 *   npx tsx scripts/dupe-candidates.ts C:\\path\\to\\events.sqlite
 *
 * v1 produced 2231 pairs and was not reviewable. Three things were wrong and
 * are fixed here:
 *
 *   1. The normaliser deleted non-ASCII letters rather than folding them, so
 *      "Lodz" collapsed to "d" and every Romanian/Ukrainian title turned to
 *      gravel. Now NFD-folded, so "Criseni" compares as "criseni".
 *   2. category='founding' rows are excluded from the title rules. Two rows
 *      called "Founding of Cornesti" are two different villages that share a
 *      name, not a duplicate. They are counted and reported, never paired.
 *   3. EXACT now requires the same start year. A +/-5 year window paired the
 *      1688 and 1690 sieges of Belgrade and two different Treaties of The
 *      Hague, all of which must survive.
 *
 * The SEED rule is the one that earns its keep: a curated year-narrative row
 * titled after a place, whose blurb names the event it is actually about.
 * Each seed row now resolves to its single best target instead of emitting a
 * line per candidate.
 *
 * Read-only. Opens the DB with readonly: true and issues no writes.
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

type Row = {
	id: string
	scope: string
	category: string
	title: string
	display_title: string | null
	blurb: string | null
	date_start: string
	date_end: string | null
	significance: number
}

const MIN_SIGNIFICANCE = 0.55
const MAX_PAIRS = 400

const CANDIDATES = ['events.sqlite', 'data/events.sqlite', 'db/events.sqlite', 'geohistory.sqlite']

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
	console.error('No DB found. Pass the path: npx tsx scripts/dupe-candidates.ts <path.sqlite>')
	process.exit(1)
}

const dbPath = findDb()
const db = new Database(dbPath, { readonly: true })
console.log('db: ' + dbPath)

// Printed so the next pass can use coordinates to separate same-named places.
const cols = (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string; type: string }>)
	.map((c) => c.name + ':' + c.type)
	.join(', ')
console.log('events columns: ' + cols)

const titleOf = (r: Row) => String(r.display_title || r.title || '')
const yearOf = (r: Row) => Number(String(r.date_start).slice(0, 4))
const isSeed = (r: Row) => r.id.startsWith('seed:')

/**
 * Fold diacritics, drop a trailing phase word, drop a trailing parenthetical,
 * drop a leading year and a leading article, then reduce punctuation to
 * spaces. Folding via NFD is the fix for v1's biggest bug: stripping
 * non-ASCII letters outright made short titles out of long ones.
 */
function normalize(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[\u0141\u0142]/g, 'l')
		.replace(/[\u00d8\u00f8]/g, 'o')
		.replace(/[\u00c6\u00e6]/g, 'ae')
		.replace(/[\u00df]/g, 'ss')
		.toLowerCase()
		.replace(/\s*[-\u2013\u2014]\s*(begins?|ends?|began|ended)\s*$/i, '')
		.replace(/\s*\([^)]*\)\s*$/, '')
		.replace(/^\s*\d{3,4}\s+/, '')
		.replace(/^the\s+/, '')
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function baseId(id: string): string {
	const hash = id.indexOf('#')
	return hash === -1 ? id : id.slice(0, hash)
}

const all = db
	.prepare(
		'SELECT id, scope, category, title, display_title, blurb, date_start, date_end, significance ' +
			'FROM events ' +
			'WHERE significance >= ? AND category NOT IN (\'birth\', \'death\') ' +
			'ORDER BY date_start',
	)
	.all(MIN_SIGNIFICANCE) as Row[]

// Founding rows are excluded from pairing but counted, because "is this one
// village or two villages with one name" is a different question needing
// coordinates, not titles.
const foundings = all.filter((r) => r.category === 'founding')
const rows = all.filter((r) => r.category !== 'founding')

console.log(
	'rows in scope: ' + rows.length + ' (excluded ' + foundings.length + ' founding rows; see FOUNDING NOTE below)',
)

const byYear = new Map<number, Row[]>()
for (const r of rows) {
	const y = yearOf(r)
	if (!Number.isFinite(y)) continue
	const list = byYear.get(y)
	if (list) list.push(r)
	else byYear.set(y, [r])
}

function near(r: Row, window: number): Row[] {
	const y = yearOf(r)
	const out: Row[] = []
	for (let d = -window; d <= window; d++) {
		const list = byYear.get(y + d)
		if (list) out.push(...list)
	}
	return out
}

type Pair = { rule: string; a: Row; b: Row; why: string; note: string }

const pairs: Pair[] = []
const seen = new Set<string>()

function add(rule: string, a: Row, b: Row, why: string, note = ''): void {
	if (a.id === b.id) return
	if (baseId(a.id) === baseId(b.id)) return
	// Two seed rows for the same place in different years are two different
	// events in a curated narrative, not a duplicate.
	if (isSeed(a) && isSeed(b)) return
	const key = [a.id, b.id].sort().join('||')
	if (seen.has(key)) return
	seen.add(key)
	const [x, y] = a.significance >= b.significance ? [a, b] : [b, a]
	pairs.push({ rule, a: x, b: y, why, note })
}

/** A whole-word containment test, so "rus" does not match inside "rusu". */
function containsPhrase(haystack: string, needle: string): boolean {
	const i = haystack.indexOf(needle)
	if (i === -1) return false
	const before = i === 0 ? ' ' : haystack[i - 1]
	const afterIndex = i + needle.length
	const after = afterIndex >= haystack.length ? ' ' : haystack[afterIndex]
	return before === ' ' && after === ' '
}

// -------------------------------------------------------------- rule 1: EXACT
const byNormalized = new Map<string, Row[]>()
for (const r of rows) {
	const n = normalize(titleOf(r))
	if (n.length < 8) continue
	const list = byNormalized.get(n)
	if (list) list.push(r)
	else byNormalized.set(n, [r])
}

for (const [n, group] of byNormalized) {
	if (group.length < 2) continue
	for (let i = 0; i < group.length; i++) {
		for (let j = i + 1; j < group.length; j++) {
			// Same year only. Sieges and treaties recur in the same city.
			if (yearOf(group[i]) !== yearOf(group[j])) continue
			add('EXACT', group[i], group[j], 'identical titles ("' + n + '") in the same year')
		}
	}
}

// --------------------------------------------------------------- rule 2: NEAR
for (const r of rows) {
	const rn = normalize(titleOf(r))
	if (rn.length < 14) continue
	for (const other of near(r, 1)) {
		if (other.category !== r.category) continue
		const on = normalize(titleOf(other))
		if (on.length < 14) continue
		if (on === rn) continue
		const longer = rn.length >= on.length ? rn : on
		const shorter = rn.length >= on.length ? on : rn
		if (!containsPhrase(longer, shorter)) continue
		add('NEAR', r, other, '"' + shorter + '" is a whole phrase inside "' + longer + '"')
	}
}

// --------------------------------------------------------------- rule 3: SEED
// One line per seed row: its single best target, with the runners-up counted
// rather than emitted.
const clusterCount = new Map<string, number>()
const seedBest: Array<{ seed: Row; target: Row; others: number }> = []

for (const seed of rows) {
	if (!isSeed(seed)) continue
	const blurb = normalize(String(seed.blurb || ''))
	if (blurb.length < 20) continue

	let best: Row | null = null
	let bestLen = 0
	let hits = 0
	for (const other of near(seed, 1)) {
		if (isSeed(other)) continue
		const on = normalize(titleOf(other))
		if (on.length < 12) continue
		if (!containsPhrase(blurb, on)) continue
		hits++
		// Prefer the most specific name the blurb commits to, then the
		// better-scored row.
		if (on.length > bestLen || (on.length === bestLen && best && other.significance > best.significance)) {
			best = other
			bestLen = on.length
		}
	}
	if (!best) continue
	seedBest.push({ seed, target: best, others: hits - 1 })
	clusterCount.set(best.id, (clusterCount.get(best.id) || 0) + 1)
}

for (const { seed, target, others } of seedBest) {
	const cluster = clusterCount.get(target.id) || 1
	const notes: string[] = []
	if (others > 0) notes.push(others + ' weaker candidate' + (others === 1 ? '' : 's') + ' ignored')
	if (cluster > 1) notes.push('CLUSTER: ' + cluster + ' seed rows point at ' + target.id)
	add('SEED', seed, target, 'seed blurb names "' + titleOf(target) + '"', notes.join('; '))
}

// ------------------------------------------------------------------- output
pairs.sort((p, q) => yearOf(p.a) - yearOf(q.a))

const counts = new Map<string, number>()
for (const p of pairs) counts.set(p.rule, (counts.get(p.rule) || 0) + 1)

console.log('\n================ CANDIDATE PAIRS ================')
console.log('Paste everything between the BEGIN and END markers back into chat.\n')
console.log('--- BEGIN TSV ---')
console.log(['pair', 'rule', 'year', 'a', 'b', 'why', 'note'].join('\t'))

let n = 0
for (const p of pairs.slice(0, MAX_PAIRS)) {
	n++
	const pid = 'D' + String(n).padStart(3, '0')
	const fmt = (r: Row) =>
		[r.id, r.scope, r.category, r.date_start, r.date_end || '-', Number(r.significance).toFixed(3), titleOf(r)].join(' | ')
	console.log([pid, p.rule, yearOf(p.a), fmt(p.a), fmt(p.b), p.why, p.note].join('\t'))
}
console.log('--- END TSV ---')

// ---------------------------------------------------------- founding note
console.log('\n================ FOUNDING NOTE ================')
const byName = new Map<string, Row[]>()
for (const f of foundings) {
	const n2 = normalize(titleOf(f))
	if (n2.length < 8) continue
	const list = byName.get(n2)
	if (list) list.push(f)
	else byName.set(n2, [f])
}
let collidingNames = 0
let collidingRows = 0
for (const [, group] of byName) {
	if (group.length < 2) continue
	collidingNames++
	collidingRows += group.length
}
console.log('  founding rows in scope: ' + foundings.length)
console.log('  names shared by 2+ rows: ' + collidingNames + ' (' + collidingRows + ' rows)')
console.log('  Not paired here. Same name + different coordinates = different village.')
console.log('  Needs a coordinate test, not a title test. See the columns printed above.')

console.log('\n================ SUMMARY ================')
for (const [rule, c] of counts) console.log('  ' + rule + ': ' + c)
console.log('  total: ' + pairs.length + (pairs.length > MAX_PAIRS ? ' (emitted first ' + MAX_PAIRS + ')' : ''))
console.log('\n  Nothing here is proof of identity. Every pair needs a human Y/N.')

db.close()
