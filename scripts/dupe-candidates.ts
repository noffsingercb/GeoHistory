/**
 * dupe-candidates.ts - read-only candidate generator for hand review.
 *
 * Run from the repo root:
 *   npx tsx scripts/dupe-candidates.ts
 *   npx tsx scripts/dupe-candidates.ts C:\\path\\to\\events.sqlite
 *
 * Produces a FINITE list of candidate duplicate pairs for a human to accept or
 * reject one by one. It is deliberately conservative: the earlier probe showed
 * that asking "does this row's blurb mention that row's title" in the wrong
 * direction matches World War I against WWII seed rows and the Holocaust
 * against Himmler's birthday. Three narrow rules only:
 *
 *   1. EXACT  - normalised titles are equal, start years within 5.
 *   2. NEAR   - one normalised title contains the other as a whole phrase
 *               (>= 12 chars), start years within 3.
 *   3. SEED   - a seed:* row's blurb contains the other row's title
 *               (>= 12 chars), start years within 1. This is the direction
 *               that works: the curated year-narrative sentence names the
 *               event it is about.
 *
 * Person rows (birth/death) are excluded outright. They are never duplicates
 * of an event, and they were the loudest false positives last time.
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

/** Only rows this significant are considered. Keeps the review list finite. */
const MIN_SIGNIFICANCE = 0.55
/** Hard stop, so nobody is handed a thousand rows to review. */
const MAX_PAIRS = 250

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

const titleOf = (r: Row) => String(r.display_title || r.title || '')
const yearOf = (r: Row) => Number(String(r.date_start).slice(0, 4))

/**
 * Lowercase, drop a trailing phase word, drop a trailing parenthetical, drop a
 * leading year, drop punctuation. "Treaty of Paris (1783)" and "treaty of
 * paris" normalise together; "1883 eruption of Krakatoa" and "Eruption of
 * Krakatoa" do too.
 */
function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/\s*[-\u2013\u2014]\s*(begins?|ends?|began|ended)\s*$/i, '')
		.replace(/\s*\([^)]*\)\s*$/, '')
		.replace(/^\s*\d{3,4}\s+/, '')
		.replace(/^the\s+/, '')
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/** The QID without its participant suffix, so Q154697#Q55290 -> Q154697. */
function baseId(id: string): string {
	const hash = id.indexOf('#')
	return hash === -1 ? id : id.slice(0, hash)
}

const rows = db
	.prepare(
		'SELECT id, scope, category, title, display_title, blurb, date_start, date_end, significance ' +
			'FROM events ' +
			'WHERE significance >= ? AND category NOT IN (\'birth\', \'death\') ' +
			'ORDER BY date_start',
	)
	.all(MIN_SIGNIFICANCE) as Row[]

console.log('rows in scope: ' + rows.length + ' (significance >= ' + MIN_SIGNIFICANCE + ', no birth/death)')

// Bucket by start year so the pairwise work stays local to a few years.
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

type Pair = { rule: string; a: Row; b: Row; why: string }

const pairs: Pair[] = []
const seen = new Set<string>()

function add(rule: string, a: Row, b: Row, why: string): void {
	if (a.id === b.id) return
	// Participant siblings of the same parent are a different ticket.
	if (baseId(a.id) === baseId(b.id)) return
	const key = [rule, a.id, b.id].sort().join('||')
	if (seen.has(key)) return
	seen.add(key)
	// Higher significance first, so "Row A" reads as the incumbent.
	const [x, y] = a.significance >= b.significance ? [a, b] : [b, a]
	pairs.push({ rule, a: x, b: y, why })
}

// -------------------------------------------------------------- rule 1: EXACT
const byNormalized = new Map<string, Row[]>()
for (const r of rows) {
	const n = normalize(titleOf(r))
	if (n.length < 6) continue
	const list = byNormalized.get(n)
	if (list) list.push(r)
	else byNormalized.set(n, [r])
}

for (const [n, group] of byNormalized) {
	if (group.length < 2) continue
	for (let i = 0; i < group.length; i++) {
		for (let j = i + 1; j < group.length; j++) {
			const gap = Math.abs(yearOf(group[i]) - yearOf(group[j]))
			if (gap > 5) continue
			add('EXACT', group[i], group[j], 'normalised titles identical ("' + n + '"), start years ' + gap + ' apart')
		}
	}
}

// --------------------------------------------------------------- rule 2: NEAR
for (const r of rows) {
	const rn = normalize(titleOf(r))
	if (rn.length < 12) continue
	for (const other of near(r, 3)) {
		const on = normalize(titleOf(other))
		if (on.length < 12) continue
		if (on === rn) continue
		const longer = rn.length >= on.length ? rn : on
		const shorter = rn.length >= on.length ? on : rn
		if (!longer.includes(shorter)) continue
		add('NEAR', r, other, '"' + shorter + '" is contained in "' + longer + '"')
	}
}

// --------------------------------------------------------------- rule 3: SEED
for (const seed of rows) {
	if (!seed.id.startsWith('seed:')) continue
	const blurb = String(seed.blurb || '').toLowerCase()
	if (blurb.length < 20) continue
	for (const other of near(seed, 1)) {
		if (other.id.startsWith('seed:')) continue
		const on = normalize(titleOf(other))
		if (on.length < 12) continue
		if (!normalize(blurb).includes(on)) continue
		add('SEED', seed, other, 'seed blurb names "' + titleOf(other) + '"; same year')
	}
}

// ------------------------------------------------------------------- output
pairs.sort((p, q) => yearOf(p.a) - yearOf(q.a))

const counts = new Map<string, number>()
for (const p of pairs) counts.set(p.rule, (counts.get(p.rule) || 0) + 1)

console.log('\n================ CANDIDATE PAIRS ================')
console.log('Paste everything between the BEGIN and END markers back into chat.\n')
console.log('--- BEGIN TSV ---')
console.log(['pair', 'rule', 'year', 'a', 'b', 'why'].join('\t'))

const emitted = pairs.slice(0, MAX_PAIRS)
let n = 0
for (const p of emitted) {
	n++
	const pid = 'C' + String(n).padStart(3, '0')
	const fmt = (r: Row) =>
		[r.id, r.scope, r.category, r.date_start, r.date_end || '-', Number(r.significance).toFixed(3), titleOf(r)].join(' | ')
	console.log([pid, p.rule, yearOf(p.a), fmt(p.a), fmt(p.b), p.why].join('\t'))
}
console.log('--- END TSV ---')

console.log('\n================ SUMMARY ================')
for (const [rule, c] of counts) console.log('  ' + rule + ': ' + c)
console.log('  total: ' + pairs.length + (pairs.length > MAX_PAIRS ? ' (emitted first ' + MAX_PAIRS + ')' : ''))
console.log('\n  Nothing here is proof of identity. Every pair needs a human Y/N.')

db.close()
