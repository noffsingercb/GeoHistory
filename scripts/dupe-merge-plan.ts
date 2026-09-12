/**
 * dupe-merge-plan.ts - read-only merge planner. v3.1.
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
 * ---------------------------------------------------------------- v3.1
 *
 * Review of v3's own MERGE block found four defects. All four are fixed here,
 * and each fix is deliberately conservative: when in doubt a pair is HELD for
 * a human rather than merged, because an unmerged duplicate is a cosmetic
 * problem and a wrong merge destroys a row.
 *
 *   1. The parent/child guard only rejected PREFIXES. It caught "athletics at
 *      the 1900 Summer Olympics - men's shot put" but not "cycling at the
 *      1906 intercalated games", which contains "intercalated games" as a
 *      SUFFIX. That shape produced 12 bad merges (five 1906 disciplines, two
 *      2012 Olympic sports, five 2015 European Games sports). Now: whenever
 *      one title contains the other and the containing title has more tokens,
 *      and neither row is a seed row, the pair is HELD. Seed rows are exempt
 *      because "Constantinople" inside "Fall of Constantinople" is exactly
 *      the narrative/entity duplicate we are hunting.
 *   2. Cluster members were merged whenever they happened to be co-located.
 *      Two seed rows both folded into the Peace of Westphalia at 0.3km, which
 *      contradicts the hand decision to keep all four clause rows. A treaty
 *      signed in one room generates N territorial clause rows that all sit on
 *      the signing coordinates, so co-location proves nothing there. Any SEED
 *      pair whose target is named by 2+ seed rows is now HELD.
 *   3. Merges were emitted PAIRWISE. Q498979 appeared in two rows with two
 *      different elected survivor dates, which is not a plan, it is a race.
 *      Merges are now grouped transitively by shared row and each group
 *      elects one survivor exactly once.
 *   4. Three pairs are hand-verified non-duplicates and are denylisted, and
 *      the surviving id now prefers a universal row so that merging a
 *      universal slug with a QID row never renames the slug.
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
const MAX_HELD_LINES = 40

/**
 * Hand-verified non-duplicates. These survived every automated gate and were
 * caught only by reading them, so they have to be named explicitly.
 *
 *   Q179001 / Q122371  - two different Treaties of Brest-Litovsk. The
 *                        February one is Ukraine's, the March one is Russia's.
 *   Q1150620 / Q150812 - the Slovak invasion of Poland was a real separate
 *                        operation. Both rows carry national centroids, so
 *                        they read as 0.0km apart.
 *   seed:british-somaliland-1941-03-16 / Q1202078 - the seed row is the 1941
 *                        British reconquest, the entity row is the 1940
 *                        Italian invasion. Seven months apart, opposite
 *                        directions.
 */
const DENYLIST = new Set(
	[
		['Q179001', 'Q122371'],
		['Q1150620', 'Q150812'],
		['seed:british-somaliland-1941-03-16', 'Q1202078'],
	].map((p) => [...p].sort().join('||')),
)

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
const isUniversal = (r: Row) => r.scope === 'universal' || r.id.startsWith('universal:')

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

const tokenCount = (s: string) => (s.length === 0 ? 0 : s.split(' ').length)

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
// their own parent. Collapsing them is a separate ticket.
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

type Pair = {
	rule: string
	a: Row
	b: Row
	why: string
	note: string
	/** True when the pair must not be auto-merged even if co-located. */
	hold?: string
}

const pairs: Pair[] = []
const seen = new Set<string>()
let rejectedAppend = 0
let rejectedDeny = 0

function add(rule: string, a: Row, b: Row, why: string, note = '', hold?: string): void {
	if (a.id === b.id) return
	if (isSeed(a) && isSeed(b)) return
	const key = [a.id, b.id].sort().join('||')
	if (seen.has(key)) return
	if (DENYLIST.has(key)) {
		rejectedDeny++
		seen.add(key)
		return
	}
	seen.add(key)
	const [x, y] = a.significance >= b.significance ? [a, b] : [b, a]
	pairs.push({ rule, a: x, b: y, why, note, hold })
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

		// v3's guard: the longer title is the shorter one with something bolted
		// onto the END. An index row and its disciplines. Silently dropped;
		// this is the large class, ~350 pairs.
		if (longer.startsWith(shorter + ' ')) {
			rejectedAppend++
			continue
		}

		// v3.1's fix: the shorter title sits anywhere else inside the longer
		// one - "intercalated games" inside "cycling at the 1906 intercalated
		// games". Also a parent/child shape, but v3 merged these. Seed rows are
		// exempt: a place-titled seed row inside an event title is the real
		// duplicate class we want.
		if (!isSeed(r) && !isSeed(other) && tokenCount(longer) > tokenCount(shorter)) {
			add(
				'NEAR',
				r,
				other,
				'"' + shorter + '" is a whole phrase inside "' + longer + '"',
				'',
				'parent/child title shape, neither row is a seed row',
			)
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
	// A treaty signed in one room produces N territorial clause rows sitting
	// on the signing coordinates. Co-location proves nothing about them, so
	// they never auto-merge regardless of distance.
	const hold = cluster > 1 ? 'cluster of ' + cluster + ' seed rows on ' + target.id + ', decided by hand' : undefined
	add('SEED', seed, target, 'seed blurb names "' + titleOf(target) + '"', notes.join('; '), hold)
}

// ----------------------------------------------------------- the distance gate
type Verdict = 'MERGE' | 'REVIEW' | 'APART' | 'HELD'

const graded = pairs.map((p) => {
	const km = distanceKm(p.a, p.b)
	let verdict: Verdict
	if (p.hold) verdict = 'HELD'
	else if (km == null) verdict = 'REVIEW'
	else if (km <= CO_LOCATED_KM) verdict = 'MERGE'
	else if (km <= REVIEW_KM) verdict = 'REVIEW'
	else verdict = 'APART'
	return { ...p, km, verdict }
})

graded.sort((x, y) => yearOf(x.a) - yearOf(y.a))

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

/**
 * Field election for a merge GROUP. Deliberately not "the entity row always
 * wins": review of the cluster set found seed rows carrying both the better
 * score and, in the NATO case, the better date. Each field is chosen on its
 * own merits and every losing row is printed so nothing disappears silently.
 */
function electGroup(members: Row[]) {
	const best = (list: Row[], pick: (x: Row, y: Row) => Row) => list.reduce(pick)
	const entities = members.filter((r) => !isSeed(r))
	const seeds = members.filter(isSeed)
	const universals = members.filter(isUniversal)

	// Title: prefer a non-seed row, which is named after the event rather than
	// the place it happened in. Highest score breaks ties.
	const titleFrom = best(entities.length ? entities : members, (x, y) => (y.significance > x.significance ? y : x))
	// Surviving id: a universal row keeps its id, always. Merging a universal
	// slug into a QID would silently rename a curated row.
	const idFrom = universals.length
		? best(universals, (x, y) => (y.significance > x.significance ? y : x))
		: titleFrom
	// Blurb: prefer a seed row, which is written as a sentence.
	const blurbFrom = seeds.length ? best(seeds, (x, y) => (y.significance > x.significance ? y : x)) : titleFrom
	// Date: whichever is most precise, tie-break to the earliest.
	const dateFrom = best(members, (x, y) => {
		const px = precisionOf(x)
		const py = precisionOf(y)
		if (px !== py) return py > px ? y : x
		return y.date_start < x.date_start ? y : x
	})
	// Scope: the widest, so a merged row is never demoted.
	const scopeFrom = best(members, (x, y) => ((SCOPE_RANK[y.scope] || 0) > (SCOPE_RANK[x.scope] || 0) ? y : x))
	// Score: the max, per the decision not to rescore the seed premium away.
	const scoreFrom = best(members, (x, y) => (y.significance > x.significance ? y : x))
	// Span: the widest correct range.
	const endFrom = best(members, (x, y) => ((y.date_end || '') > (x.date_end || '') ? y : x))
	return { titleFrom, idFrom, blurbFrom, dateFrom, scopeFrom, scoreFrom, endFrom }
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
const helds = graded.filter((g) => g.verdict === 'HELD')

// ------------------------------------------------------- transitive grouping
// v3 emitted one line per PAIR, so a target matched by two rows produced two
// merge rows with two different elected dates. Group first, elect once.
const parent = new Map<string, string>()
function find(id: string): string {
	let p = parent.get(id)
	if (p === undefined) {
		parent.set(id, id)
		return id
	}
	while (p !== id) {
		id = p
		p = parent.get(id) as string
	}
	return id
}
function union(x: string, y: string): void {
	const rx = find(x)
	const ry = find(y)
	if (rx !== ry) parent.set(rx, ry)
}

const rowById = new Map<string, Row>()
for (const g of merges) {
	rowById.set(g.a.id, g.a)
	rowById.set(g.b.id, g.b)
	union(g.a.id, g.b.id)
}

type Group = { members: Row[]; rules: Set<string>; maxKm: number }
const groups = new Map<string, Group>()
for (const g of merges) {
	const root = find(g.a.id)
	let grp = groups.get(root)
	if (!grp) {
		grp = { members: [], rules: new Set(), maxKm: 0 }
		groups.set(root, grp)
	}
	for (const r of [g.a, g.b]) if (!grp.members.some((m) => m.id === r.id)) grp.members.push(r)
	grp.rules.add(g.rule)
	if (g.km != null && g.km > grp.maxKm) grp.maxKm = g.km
}

const groupList = [...groups.values()].sort((x, y) => yearOf(x.members[0]) - yearOf(y.members[0]))
const multiRowGroups = groupList.filter((g) => g.members.length > 2)

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
for (const grp of groupList) {
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

if (multiRowGroups.length > 0) {
	console.log('\n  groups with more than two rows (these are the ones v3 got wrong):')
	for (const grp of multiRowGroups) {
		const e = electGroup(grp.members)
		console.log('    ' + e.idFrom.id + ' <- ' + grp.members.map((r) => r.id).join(' + '))
	}
}

console.log('\n================ HELD (co-located but not auto-merged) ================')
console.log('These look like duplicates and sit close together, but a structural')
console.log('reason says do not merge them automatically. Hand review only.\n')
for (const g of helds.slice(0, MAX_HELD_LINES)) {
	console.log([g.rule, yearOf(g.a), g.km == null ? 'no-coords' : g.km.toFixed(1) + 'km', g.hold].join('\t'))
	console.log('    ' + fmt(g.a))
	console.log('    ' + fmt(g.b))
}
if (helds.length > MAX_HELD_LINES) console.log('  ... and ' + (helds.length - MAX_HELD_LINES) + ' more')

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
console.log('  MERGE  groups planned:        ' + groupList.length)
console.log('  MERGE  rows they consume:     ' + groupList.reduce((n, g) => n + g.members.length, 0))
console.log('  MERGE  groups over two rows:  ' + multiRowGroups.length)
console.log('  HELD   (co-located, hand):    ' + helds.length)
console.log('  REVIEW (borderline):          ' + reviews.length)
console.log('  APART  (rejected by gate):    ' + aparts.length)
console.log('  candidates generated:         ' + graded.length)
console.log('  parent/child appended titles rejected silently: ' + rejectedAppend)
console.log('  hand-verified non-duplicates denylisted:        ' + rejectedDeny + ' of ' + DENYLIST.size)
console.log('  participant-sibling rows excluded from scope:   ' + siblings.length)
console.log('\n  Read-only. Nothing was written. The MERGE block is a proposal.')

db.close()
