/**
 * dupe-plan.ts - the duplicate merge planner, as a library.
 *
 * This is the v3.1 planner from scripts/dupe-merge-plan.ts, moved here
 * unchanged so that the planner and the applier cannot drift apart. A plan
 * that is printed for review and a plan that is applied to the dataset MUST
 * be produced by the same code; otherwise the review approves one thing and
 * the write performs another.
 *
 * Nothing in this file writes. See lib/dupe-apply.ts for the write side.
 *
 * ---------------------------------------------------------------------------
 * The rule this whole pass is built on:
 *
 * Two rows are the same event when they name the same thing AND sit in the
 * same place. Title similarity alone is not evidence - a seed row titled
 * after a territory and an entity row sitting at a signing ceremony 300km
 * away are two different rows that both deserve to exist.
 *
 *   <= CO_LOCATED_KM -> MERGE   (planned automatically)
 *   <= REVIEW_KM     -> REVIEW  (borderline, needs a human)
 *   >  REVIEW_KM     -> APART   (rejected; different places)
 *   structural hold  -> HELD    (looks close, but must not auto-merge)
 */
import type { Database as Db } from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export type Row = {
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

export const MIN_SIGNIFICANCE = 0.55
export const CO_LOCATED_KM = 25
export const REVIEW_KM = 250

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
export const DENYLIST = new Set(
	[
		['Q179001', 'Q122371'],
		['Q1150620', 'Q150812'],
		['seed:british-somaliland-1941-03-16', 'Q1202078'],
	].map((p) => [...p].sort().join('||')),
)

const CANDIDATES = ['events.sqlite', 'data/events.sqlite', 'db/events.sqlite', 'geohistory.sqlite']

/** Resolve the DB path from an explicit argument, else the usual locations. */
export function findDb(explicit?: string): string {
	if (explicit) {
		const p = resolve(process.cwd(), explicit)
		if (!existsSync(p)) throw new Error('No file at ' + p)
		return p
	}
	for (const c of CANDIDATES) {
		const p = resolve(process.cwd(), c)
		if (existsSync(p)) return p
	}
	throw new Error('No DB found. Pass the path as the first argument.')
}

export const titleOf = (r: Row) => String(r.display_title || r.title || '')
export const yearOf = (r: Row) => Number(String(r.date_start).slice(0, 4))
export const isSeed = (r: Row) => r.id.startsWith('seed:')
export const isSibling = (r: Row) => r.id.includes('#')
export const isUniversal = (r: Row) => r.scope === 'universal' || r.id.startsWith('universal:')

export function normalize(s: string): string {
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
export function distanceKm(a: Row, b: Row): number | null {
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
export function containsPhrase(haystack: string, needle: string): boolean {
	const i = haystack.indexOf(needle)
	if (i === -1) return false
	const before = i === 0 ? ' ' : haystack[i - 1]
	const afterIndex = i + needle.length
	const after = afterIndex >= haystack.length ? ' ' : haystack[afterIndex]
	return before === ' ' && after === ' '
}

export const ROW_COLUMNS =
	'id, scope, category, title, display_title, blurb, date_start, date_end, date_precision, lat, lng, significance'

/** Load one row by id, with exactly the columns the planner reasons about. */
export function loadRow(db: Db, id: string): Row | undefined {
	return db.prepare('SELECT ' + ROW_COLUMNS + ' FROM events WHERE id = ?').get(id) as Row | undefined
}

/**
 * The rows the planner considers: scored above the floor, not a person row,
 * not a founding row (47k homonymous villages need a coordinate test, not a
 * title test), and not a participant sibling (collapsing those is a separate
 * ticket, so they are excluded outright rather than de-duplicated).
 */
export function loadRows(db: Db): { rows: Row[]; siblings: Row[]; noCoords: number } {
	const all = db
		.prepare(
			'SELECT ' +
				ROW_COLUMNS +
				' FROM events ' +
				"WHERE significance >= ? AND category NOT IN ('birth', 'death') AND category <> 'founding' " +
				'ORDER BY date_start',
		)
		.all(MIN_SIGNIFICANCE) as Row[]
	const siblings = all.filter(isSibling)
	const rows = all.filter((r) => !isSibling(r))
	const noCoords = rows.filter((r) => r.lat == null || r.lng == null).length
	return { rows, siblings, noCoords }
}

export type Verdict = 'MERGE' | 'REVIEW' | 'APART' | 'HELD'

export type Pair = {
	rule: string
	a: Row
	b: Row
	why: string
	note: string
	/** Set when the pair must not be auto-merged even if co-located. */
	hold?: string
}

export type Graded = Pair & { km: number | null; verdict: Verdict }

export type Group = { members: Row[]; rules: Set<string>; maxKm: number }

export type Plan = {
	graded: Graded[]
	merges: Graded[]
	reviews: Graded[]
	aparts: Graded[]
	helds: Graded[]
	groupList: Group[]
	multiRowGroups: Group[]
	rejectedAppend: number
	rejectedDeny: number
}

/** Build the whole plan from a row set. Pure: no DB access, no writes. */
export function buildPlan(rows: Row[]): Plan {
	const byYear = new Map<number, Row[]>()
	for (const r of rows) {
		const y = yearOf(r)
		if (!Number.isFinite(y)) continue
		const list = byYear.get(y)
		if (list) list.push(r)
		else byYear.set(y, [r])
	}

	const near = (r: Row, window: number): Row[] => {
		const y = yearOf(r)
		const out: Row[] = []
		for (let d = -window; d <= window; d++) {
			const list = byYear.get(y + d)
			if (list) out.push(...list)
		}
		return out
	}

	const pairs: Pair[] = []
	const seen = new Set<string>()
	let rejectedAppend = 0
	let rejectedDeny = 0

	const add = (rule: string, a: Row, b: Row, why: string, note = '', hold?: string): void => {
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

	// ------------------------------------------------------------ rule 1: EXACT
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

	// ------------------------------------------------------------- rule 2: NEAR
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

			// The longer title is the shorter one with something bolted onto the
			// END: an index row and its disciplines. Silently dropped; this is
			// the large class, ~350 pairs.
			if (longer.startsWith(shorter + ' ')) {
				rejectedAppend++
				continue
			}

			// The shorter title sits anywhere else inside the longer one -
			// "intercalated games" inside "cycling at the 1906 intercalated
			// games". Also a parent/child shape. Seed rows are exempt, because a
			// place-titled seed row inside an event title is the real duplicate
			// class we are hunting.
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

	// ------------------------------------------------------------- rule 3: SEED
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
		const hold =
			cluster > 1 ? 'cluster of ' + cluster + ' seed rows on ' + target.id + ', decided by hand' : undefined
		add('SEED', seed, target, 'seed blurb names "' + titleOf(target) + '"', notes.join('; '), hold)
	}

	// ------------------------------------------------------- the distance gate
	const graded: Graded[] = pairs.map((p) => {
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

	const merges = graded.filter((g) => g.verdict === 'MERGE')
	const reviews = graded.filter((g) => g.verdict === 'REVIEW')
	const aparts = graded.filter((g) => g.verdict === 'APART')
	const helds = graded.filter((g) => g.verdict === 'HELD')

	// --------------------------------------------------- transitive grouping
	// One line per PAIR would let a target matched by two rows produce two
	// merge rows with two different elected dates. Group first, elect once.
	const parent = new Map<string, string>()
	const find = (id: string): string => {
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
	const union = (x: string, y: string): void => {
		const rx = find(x)
		const ry = find(y)
		if (rx !== ry) parent.set(rx, ry)
	}
	for (const g of merges) union(g.a.id, g.b.id)

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

	return { graded, merges, reviews, aparts, helds, groupList, multiRowGroups, rejectedAppend, rejectedDeny }
}

const PRECISION_RANK: Record<string, number> = { day: 3, month: 2, year: 1 }
export function precisionOf(r: Row): number {
	const p = String(r.date_precision || '').toLowerCase()
	if (PRECISION_RANK[p]) return PRECISION_RANK[p]
	// Fall back to the shape of the string when precision is not recorded.
	const s = String(r.date_start)
	if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !s.endsWith('-01-01')) return 3
	if (/^\d{4}-\d{2}/.test(s)) return 2
	return 1
}

export const SCOPE_RANK: Record<string, number> = { local: 1, regional: 2, national: 3, global: 4, universal: 5 }

export type Election = {
	titleFrom: Row
	idFrom: Row
	blurbFrom: Row
	dateFrom: Row
	scopeFrom: Row
	scoreFrom: Row
	endFrom: Row
}

/**
 * Field election for a merge GROUP. Deliberately not "the entity row always
 * wins": review of the cluster set found seed rows carrying both the better
 * score and, in the NATO case, the better date. Each field is chosen on its
 * own merits and every losing row is reported so nothing disappears silently.
 *
 * pinId forces the surviving id, which is how the hand verdicts from the
 * review table name a survivor the automatic rules would not have picked.
 */
export function electGroup(members: Row[], pinId?: string): Election {
	const byScore = (x: Row, y: Row) => (y.significance > x.significance ? y : x)
	const best = (list: Row[], pick: (x: Row, y: Row) => Row) => list.reduce(pick)
	const entities = members.filter((r) => !isSeed(r))
	const seeds = members.filter(isSeed)
	const universals = members.filter(isUniversal)

	// Title: prefer a non-seed row, which is named after the event rather than
	// the place it happened in. Highest score breaks ties.
	const titleFrom = best(entities.length ? entities : members, byScore)

	// Surviving id: an explicit pin wins; otherwise a universal row keeps its
	// id, always. Merging a universal slug into a QID would silently rename a
	// curated row.
	let idFrom: Row
	if (pinId) {
		const pinned = members.find((r) => r.id === pinId)
		if (!pinned) throw new Error('pinned survivor ' + pinId + ' is not a member of the group')
		idFrom = pinned
	} else {
		idFrom = universals.length ? best(universals, byScore) : titleFrom
	}

	// Blurb: prefer a seed row, which is written as a sentence.
	const blurbFrom = seeds.length ? best(seeds, byScore) : titleFrom
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
	const scoreFrom = best(members, byScore)
	// Span: the widest correct range.
	const endFrom = best(members, (x, y) => ((y.date_end || '') > (x.date_end || '') ? y : x))
	return { titleFrom, idFrom, blurbFrom, dateFrom, scopeFrom, scoreFrom, endFrom }
}

/** One-line row rendering used by every report in this pass. */
export const fmt = (r: Row) =>
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
