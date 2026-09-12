/**
 * dupe-merge-plan.ts - read-only merge planner. v3.
 *
 * Run from the repo root:
 *   npx tsx scripts/dupe-merge-plan.ts
 *   npx tsx scripts/dupe-merge-plan.ts C:\\path\\to\\events.sqlite
 *
 * v2 (dupe-candidates.ts) produced 566 pairs for hand review. Review of the
 * first 400 established that the discriminator is not the title at all - it
 * is the coordinates. Two rows are the same event when they name the same
 * thing AND sit in the same place. A seed row titled after a territory and
 * an entity row sitting at a signing ceremony 300km away are two different
 * rows that both deserve to exist.
 *
 * So this pass keeps v2's three title rules as the *candidate* generator and
 * adds a distance gate as the *decision*:
 *
 *   <= CO_LOCATED_KM        -> MERGE   (planned automatically)
 *   <= REVIEW_KM            -> REVIEW  (borderline, needs a human)
 *   >  REVIEW_KM            -> APART   (rejected; different places)
 *
 * It also drops two noise classes that review identified in v2's output:
 *
 *   1. Parent/child sports rows. "athletics at the 1900 Summer Olympics" is a
 *      whole phrase inside "athletics at the 1900 Summer Olympics - men's
 *      shot put", which is an index row and its disciplines, not a duplicate.
 *      Any pair where the longer title merely APPENDS to the shorter is out.
 *      That was roughly 50 of v2's 400.
 *   2. Participant siblings. Rows with '#' in the id are per-participant
 *      expansions of a parent event (expand-participants.ts). v2 excluded
 *      same-base pairs but a seed row still matched each sibling separately,
 *      and worse, EXACT paired the 1814 Treaty of Paris against the 1815 one
 *      because one of them is a sibling row. Sibling rows are excluded
 *      entirely here; collapsing them is a separate ticket.
 *
 * Read-only. Opens the DB with readonly: true and issues no writes. The
 * output is a plan to be reviewed, not an applied change.
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
	date_precision: string | null
	lat: number | null
	lng: number | null
	significance: number
}

const MIN_SIGNIFICANCE = 0.55
const CO_LOCATED_KM = 25
const REVIEW_KM = 250
const MAX_REVIEW_LINES = 60

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
	console.error('No DB found. Pass the path: npx tsx scripts/dupe-merge-plan.ts <path.sqlite>')
	process.exit(1)
}

const dbPath = findDb()
const db = new Database(dbPath, { readonly: true })
console.log('db: ' + dbPath)
console.log('co-located <= ' + CO_LOCATED_KM + 'km | review <= ' + REVIEW_KM + 'km | apart > ' + REVIEW_KM + 'km')

const titleOf = (r: Row) => String(r.display_title || r.title || '')
const yearOf = (r: Row) => Number(String(r.date_start).slice(0, 4))
const isSeed = (r: Row) => r.id.startsWith('seed:')
const isSibling = (r: Row) => r.id.includes('#')

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

/** Great-circle distance in km. Returns null when either row has no coords. */
function distanceKm(a: Row, b: Row): number | null {
	if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null
	const R = 6371
	const toRad = (d: number) => (d * Math.PI) / 180
	const dLat = toRad(b.lat - a.lat)
	const dLng = toRad(b.lng - a.lng)
	const h =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
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

const all = db
	.prepare(
		'SELECT id, scope, category, title, display_title, blurb, date_start, date_end, date_precision, ' +
			'lat, lng, significance ' +
			'FROM events ' +
			"WHERE significance >= ? AND category NOT IN ('birth', 'death') AND category <> 'founding' " +
			'ORDER BY date_start',
	)
	.all(MIN_SIGNIFICANCE) as Row[]

// Participant siblings are excluded outright, not just de-duplicated against
// their own parent. See header note 2.
const siblings = all.filter(isSibling)
const rows = all.filter((r) => !isSibling(r))
console.log('rows in scope: ' + rows.length + ' (excluded ' + siblings.length + ' participant-sibling rows)')

const noCoords = rows.filter((r) => r.lat == null || r.lng == null).length
if (noCoords > 0) console.log('rows without coordinates: ' + noCoords + ' (these can never be gated; they go to REVIEW)')

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
let rejectedAppend = 0

function add(rule: string, a: Row, b: Row, why: string, note = ''): void {
	if (a.id === b.id) return
	if (isSeed(a) && isSeed(b)) return
	const key = [a.id, b.id].sort().join('||')
	if (seen.has(key)) return
	seen.add(key)
	const [x, y] = a.significance >= b.significance ? [a, b] : [b, a]
	pairs.push({ rule, a: x, b: y, why, note })
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
		// The Olympic parent/discipline killer: if the longer title is the
		// shorter one with something bolted onto the end, it is a child row.
		if (longer.startsWith(shorter + ' ')) {
			rejectedAppend++
			continue
		}
		add('NEAR', r, other, '"' + shorter + '" is a whole phrase inside "' + longer + '"')
	}
}

// --------------------------------------------------------------- rule 3: SEED
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

// ----------------------------------------------------------- the distance gate
type Verdict = 'MERGE' | 'REVIEW' | 'APART'

const graded = pairs.map((p) => {
	const km = distanceKm(p.a, p.b)
	let verdict: Verdict
	if (km == null) verdict = 'REVIEW'
	else if (km <= CO_LOCATED_KM) verdict = 'MERGE'
	else if (km <= REVIEW_KM) verdict = 'REVIEW'
	else verdict = 'APART'
	return { ...p, km, verdict }
})

graded.sort((x, y) => yearOf(x.a) - yearOf(y.a))

/**
 * Field election for a merge. Deliberately not "the entity row always wins":
 * review of the cluster set found seed rows carrying both the better score
 * and, in the NATO case, the better date. So each field is chosen on its own
 * merits and the losing value is printed so nothing disappears silently.
 */
const PRECISION_RANK: Record<string, number> = { day: 3, month: 2, year: 1 }
function precisionOf(r: Row): number {
	const p = String(r.date_precision || '').toLowerCase()
	if (PRECISION_RANK[p]) return PRECISION_RANK[p]
	// Fall back to the shape of the string when precision is not recorded.
	const s = String(r.date_start)
	if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !s.endsWith('-01-01')) return 3
	if (/^\d{4}-\d{2}/.test(s)) return 2
	return 1
}

const SCOPE_RANK: Record<string, number> = { local: 1, regional: 2, national: 3, global: 4, universal: 5 }

function electFields(a: Row, b: Row) {
	// Title: prefer the non-seed row, which is named after the event rather
	// than the place it happened in.
	const titleFrom = isSeed(a) && !isSeed(b) ? b : !isSeed(a) && isSeed(b) ? a : a
	// Blurb: prefer the seed row, which is written as a sentence.
	const blurbFrom = isSeed(a) ? a : isSeed(b) ? b : a
	// Date: whichever is more precise, tie-break to the earlier one.
	const pa = precisionOf(a)
	const pb = precisionOf(b)
	const dateFrom = pa !== pb ? (pa > pb ? a : b) : a.date_start <= b.date_start ? a : b
	// Scope: the wider of the two, so a merged row is never demoted.
	const scopeFrom = (SCOPE_RANK[a.scope] || 0) >= (SCOPE_RANK[b.scope] || 0) ? a : b
	// Score: the max, per the decision not to rescore the seed premium away.
	const scoreFrom = a.significance >= b.significance ? a : b
	// Span: the widest correct range.
	const endFrom = (a.date_end || '') >= (b.date_end || '') ? a : b
	return { titleFrom, blurbFrom, dateFrom, scopeFrom, scoreFrom, endFrom }
}

// ------------------------------------------------------------------- output
const fmt = (r: Row) =>
	[
		r.id,
		r.scope,
		r.category,
		r.date_start,
		r.date_end || '-',
		Number(r.significance).toFixed(3),
		r.lat == null ? '?' : Number(r.lat).toFixed(2) + ',' + Number(r.lng).toFixed(2),
		titleOf(r),
	].join(' | ')

const merges = graded.filter((g) => g.verdict === 'MERGE')
const reviews = graded.filter((g) => g.verdict === 'REVIEW')
const aparts = graded.filter((g) => g.verdict === 'APART')

console.log('\n================ MERGE PLAN (co-located) ================')
console.log('These passed the coordinate gate. Paste between the markers.\n')
console.log('--- BEGIN MERGE TSV ---')
console.log(['id', 'rule', 'year', 'km', 'survivor_title', 'survivor_date', 'survivor_scope', 'survivor_score', 'losing_row', 'kept_row'].join('\t'))
let m = 0
for (const g of merges) {
	m++
	const e = electFields(g.a, g.b)
	const loser = e.titleFrom.id === g.a.id ? g.b : g.a
	console.log(
		[
			'M' + String(m).padStart(3, '0'),
			g.rule,
			yearOf(g.a),
			g.km == null ? '?' : g.km.toFixed(1),
			titleOf(e.titleFrom),
			e.dateFrom.date_start + (e.endFrom.date_end ? ' -> ' + e.endFrom.date_end : ''),
			e.scopeFrom.scope,
			Number(e.scoreFrom.significance).toFixed(3),
			loser.id,
			e.titleFrom.id,
		].join('\t'),
	)
}
console.log('--- END MERGE TSV ---')

console.log('\n================ REVIEW (borderline distance) ================')
console.log('Between ' + CO_LOCATED_KM + 'km and ' + REVIEW_KM + 'km, or missing coordinates.\n')
for (const g of reviews.slice(0, MAX_REVIEW_LINES)) {
	console.log(
		[g.rule, yearOf(g.a), g.km == null ? 'no-coords' : g.km.toFixed(1) + 'km', fmt(g.a), fmt(g.b), g.note]
			.filter(Boolean)
			.join('\t'),
	)
}
if (reviews.length > MAX_REVIEW_LINES) console.log('  ... and ' + (reviews.length - MAX_REVIEW_LINES) + ' more')

console.log('\n================ APART (rejected, different places) ================')
const apartByRule = new Map<string, number>()
for (const g of aparts) apartByRule.set(g.rule, (apartByRule.get(g.rule) || 0) + 1)
for (const [rule, c] of apartByRule) console.log('  ' + rule + ': ' + c)
const farthest = [...aparts].sort((x, y) => (y.km || 0) - (x.km || 0)).slice(0, 10)
console.log('  farthest 10, as a sanity check that the gate is rejecting the right things:')
for (const g of farthest) {
	console.log('    ' + (g.km || 0).toFixed(0) + 'km  ' + titleOf(g.a) + '  <->  ' + titleOf(g.b))
}

console.log('\n================ SUMMARY ================')
console.log('  MERGE  (co-located, planned): ' + merges.length)
console.log('  REVIEW (borderline):          ' + reviews.length)
console.log('  APART  (rejected by gate):    ' + aparts.length)
console.log('  candidates generated:         ' + graded.length)
console.log('  parent/child title pairs rejected before gating: ' + rejectedAppend)
console.log('  participant-sibling rows excluded from scope:    ' + siblings.length)
console.log('\n  Read-only. Nothing was written. The MERGE block is a proposal.')

db.close()
