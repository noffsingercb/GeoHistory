/**
 * dupe-apply.ts - the write side of the duplicate merge.
 *
 * Shared by scripts/dupe-merge-apply.ts (the 132 automatic co-located groups)
 * and scripts/dupe-merge-manual.ts (the hand verdicts from the review table).
 *
 * Everything destructive lives here, in one place, with the same guards for
 * both callers:
 *
 *   - dry run by default; --apply is required to write
 *   - the DB is copied to a timestamped backup before the first write
 *   - one transaction: either the whole pass lands or none of it does
 *   - a universal row is never deleted
 *   - a row that survives one group is never deleted by another
 *   - deleted seed rows are also removed from the seed JSON, otherwise the
 *     next `npm run seed` restores every row this pass just merged
 *   - events_fts is an external-content FTS5 table, so it is rebuilt after
 *     the deletes rather than left pointing at dead rowids
 *   - what happened is recorded in meta
 */
import type { Database as Db } from 'better-sqlite3'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Election, type Row, electGroup, fmt, isUniversal, loadRow, titleOf } from './dupe-plan.js'

/** A merge to apply: these ids become one row, and survivorId is that row. */
export type MergeSpec = {
	/** Label for the report: M007 from the plan, or G014 / P005 / R023 from the table. */
	id: string
	/** Every row in the group, survivor included. */
	memberIds: string[]
	/** Forced surviving id. Omit to let the planner's election choose. */
	survivorId?: string
	/** Free-text provenance printed with the group. */
	note?: string
	/**
	 * Field overrides applied after the election. Used for the handful of
	 * verdicts where a human corrected a field the rules get wrong, e.g. the
	 * Krakatoa row's category.
	 */
	overrides?: Partial<Pick<Row, 'category' | 'scope' | 'date_start' | 'date_end' | 'date_precision'>> & {
		display_title?: string
	}
}

export type ApplyOptions = {
	apply: boolean
	dbPath: string
	/** Where the seed JSON lives; its rows are the source of truth for seed:*. */
	repoRoot: string
	/** meta key recording this pass, e.g. 'last_auto_dupe_merge'. */
	metaKey: string
	label: string
}

export type ApplyResult = {
	groupsApplied: number
	rowsDeleted: number
	fieldsUpdated: number
	skippedAlreadyMerged: number
	skipped: Array<{ id: string; reason: string }>
	deletedSeedIds: string[]
}

const SEED_FILES = [
	'timeline-wikipedia-1-pre1700.json',
	'timeline-wikipedia-2-1700-1849.json',
	'timeline-wikipedia-3-1850-1919.json',
	'timeline-wikipedia-4-1920-1979.json',
	'timeline-wikipedia-5-1980-present.json',
]

// Copied from merge-universal-dupes.ts, which copied it from
// prune-seed-dupes.ts, because neither exports it. Keep synchronized with
// seed.ts: if seed id derivation changes, seed donors stop being removed from
// the JSON and the next seed run silently restores merged rows.
function slugify(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 90)
}

function seedRowId(row: Record<string, unknown>): string {
	const explicit = String(row['Seed ID'] ?? '')
		.trim()
		.replace(/^seed:/, '')
	return 'seed:' + slugify(explicit || String(row.Title ?? '').trim())
}

export function backupDb(dbPath: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const target = dbPath + '.pre-dedupe-' + stamp + '.bak'
	copyFileSync(dbPath, target)
	return target
}

/**
 * Apply a list of merges. The whole thing runs inside one transaction so a
 * guard failure halfway through leaves the dataset exactly as it was.
 */
export function applyMerges(db: Db, specs: MergeSpec[], opts: ApplyOptions): ApplyResult {
	const result: ApplyResult = {
		groupsApplied: 0,
		rowsDeleted: 0,
		fieldsUpdated: 0,
		skippedAlreadyMerged: 0,
		skipped: [],
		deletedSeedIds: [],
	}

	// A row that survives one group must never be a casualty of another. This
	// is the guard that makes running the automatic and the manual pass in
	// either order safe.
	const survivors = new Set<string>()
	for (const spec of specs) {
		const pinned = spec.survivorId
		if (pinned) survivors.add(pinned)
	}

	const updateRow = db.prepare(
		'UPDATE events SET display_title = ?, blurb = ?, date_start = ?, date_end = ?, ' +
			'date_precision = ?, scope = ?, significance = ?, category = ? WHERE id = ?',
	)
	const deleteRow = db.prepare("DELETE FROM events WHERE id = ? AND scope != 'universal'")

	const run = db.transaction(() => {
		for (const spec of specs) {
			const members = spec.memberIds
				.map((id) => loadRow(db, id))
				.filter((r): r is Row => r !== undefined)
			const missing = spec.memberIds.length - members.length

			if (members.length === 0) {
				result.skippedAlreadyMerged++
				console.log('  ' + spec.id + ': all rows already gone; nothing to do')
				continue
			}
			if (members.length === 1) {
				// The other side was merged by an earlier pass. Idempotent re-run.
				result.skippedAlreadyMerged++
				console.log('  ' + spec.id + ': already merged into ' + members[0].id + ' (' + missing + ' row(s) absent)')
				continue
			}

			let election: Election
			try {
				election = electGroup(members, spec.survivorId)
			} catch (e) {
				result.skipped.push({ id: spec.id, reason: (e as Error).message })
				continue
			}

			const survivor = election.idFrom
			const losers = members.filter((r) => r.id !== survivor.id)

			const universalLoser = losers.find(isUniversal)
			if (universalLoser) {
				result.skipped.push({
					id: spec.id,
					reason: 'would delete universal row ' + universalLoser.id + '; refusing',
				})
				continue
			}
			const protectedLoser = losers.find((r) => survivors.has(r.id))
			if (protectedLoser) {
				result.skipped.push({
					id: spec.id,
					reason: protectedLoser.id + ' is the survivor of another group; refusing',
				})
				continue
			}

			const next = {
				display_title: spec.overrides?.display_title ?? titleOf(election.titleFrom),
				blurb: election.blurbFrom.blurb ?? survivor.blurb,
				date_start: spec.overrides?.date_start ?? election.dateFrom.date_start,
				date_end: spec.overrides?.date_end ?? election.endFrom.date_end,
				date_precision: spec.overrides?.date_precision ?? election.dateFrom.date_precision,
				scope: spec.overrides?.scope ?? election.scopeFrom.scope,
				significance: election.scoreFrom.significance,
				category: spec.overrides?.category ?? survivor.category,
			}

			console.log(
				'  ' +
					spec.id +
					': ' +
					(opts.apply ? 'merge' : 'would merge') +
					' ' +
					members.length +
					' rows -> ' +
					survivor.id +
					(spec.note ? '   [' + spec.note + ']' : ''),
			)
			console.log('      keep   ' + fmt(survivor))
			for (const l of losers) console.log('      delete ' + fmt(l))
			console.log(
				'      after  ' +
					[
						next.display_title,
						next.date_start + (next.date_end ? ' -> ' + next.date_end : ''),
						next.scope,
						next.category,
						Number(next.significance).toFixed(3),
						'blurb from ' + election.blurbFrom.id,
					].join(' | '),
			)

			if (opts.apply) {
				updateRow.run(
					next.display_title,
					next.blurb,
					next.date_start,
					next.date_end,
					next.date_precision,
					next.scope,
					next.significance,
					next.category,
					survivor.id,
				)
				for (const l of losers) {
					const res = deleteRow.run(l.id)
					if (res.changes !== 1) {
						throw new Error('delete guard rejected ' + l.id + ' in ' + spec.id + '; transaction rolled back')
					}
				}
			}

			survivors.add(survivor.id)
			result.groupsApplied++
			result.fieldsUpdated++
			result.rowsDeleted += losers.length
			for (const l of losers) if (l.id.startsWith('seed:')) result.deletedSeedIds.push(l.id)
		}

		if (opts.apply) {
			// External-content FTS5: the index still references deleted rowids
			// until it is rebuilt.
			db.exec("INSERT INTO events_fts(events_fts) VALUES('rebuild');")
			db.prepare(
				'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
			).run(
				opts.metaKey,
				result.groupsApplied +
					' groups merged, ' +
					result.rowsDeleted +
					' rows deleted at ' +
					new Date().toISOString(),
			)
		}
	})

	run()
	return result
}

/**
 * Remove merged seed rows from the seed JSON, so `npm run seed` cannot
 * restore them. Without this the merge is undone by the next rebuild.
 */
export function pruneSeedJson(repoRoot: string, deletedSeedIds: string[], apply: boolean): void {
	if (deletedSeedIds.length === 0) {
		console.log('\nSeed JSON: no seed rows were merged; nothing to prune.')
		return
	}
	const targets = new Set(deletedSeedIds)
	const unmatched = new Set(targets)
	let removed = 0

	console.log('\n================ SEED JSON ================')
	console.log('Merged seed rows must also leave the JSON, or `npm run seed` restores them.\n')

	for (const name of SEED_FILES) {
		const path = join(repoRoot, 'seed', name)
		if (!existsSync(path)) {
			console.log('  seed/' + name + ': not found; skipped')
			continue
		}
		const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>
		const kept = rows.filter((row) => {
			const id = seedRowId(row)
			if (!targets.has(id)) return true
			unmatched.delete(id)
			removed++
			return false
		})
		const delta = rows.length - kept.length
		if (delta > 0 && apply) writeFileSync(path, JSON.stringify(kept, null, 2) + '\n', 'utf8')
		console.log('  seed/' + name + ': ' + rows.length + ' -> ' + kept.length + ' (-' + delta + ')')
	}

	console.log('\n  ' + (apply ? 'removed' : 'would remove') + ' ' + removed + ' seed JSON row(s).')
	if (unmatched.size > 0) {
		console.log('  NOTE: ' + unmatched.size + ' merged seed id(s) matched no JSON row.')
		console.log('  Expected on a re-run. On a first run it means Seed ID drift - investigate before shipping.')
		for (const id of [...unmatched].slice(0, 10)) console.log('    ' + id)
		if (unmatched.size > 10) console.log('    ... and ' + (unmatched.size - 10) + ' more')
	}
}

export function reportResult(result: ApplyResult, apply: boolean): void {
	console.log('\n================ SUMMARY ================')
	console.log('  groups ' + (apply ? 'merged' : 'that would merge') + ':      ' + result.groupsApplied)
	console.log('  rows ' + (apply ? 'deleted' : 'that would be deleted') + ': ' + result.rowsDeleted)
	console.log('  already merged (no-op):        ' + result.skippedAlreadyMerged)
	console.log('  skipped by a guard:            ' + result.skipped.length)
	for (const s of result.skipped) console.log('    ' + s.id + ': ' + s.reason)
	if (!apply) {
		console.log('\n  DRY RUN. Nothing was written. Re-run with --apply to write.')
	} else {
		console.log('\n  Applied. Re-run the scoring/reach pass next: deleting rows shifts')
		console.log('  significance percentiles, and widened scope needs reach_km recomputed.')
	}
}
