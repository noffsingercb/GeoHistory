/**
 * dataset-stamp.ts - read and bump the dataset version stamp in meta.
 *
 *   npx tsx scripts/dataset-stamp.ts                                  -> print meta
 *   npx tsx scripts/dataset-stamp.ts --apply --version dump-v0.6.1    -> bump
 *
 * Why this exists: /v1/meta and the Circa footer report the dataset version,
 * and a dedupe pass that deletes rows without moving that string produces two
 * different datasets claiming to be the same one. Every earlier rollout
 * failure in this project came from a stamp that did not move.
 *
 * The script does not guess which key holds the version. It prints every meta
 * row, then rewrites only the keys whose current value looks like a dump
 * version (dump-vX.Y), and records the previous value alongside. If no such
 * key exists it says so and writes nothing, rather than inventing a key name.
 */
import Database from 'better-sqlite3'
import { findDb } from './lib/dupe-plan.js'

const APPLY = process.argv.includes('--apply')
const versionIndex = process.argv.indexOf('--version')
const VERSION = versionIndex !== -1 ? process.argv[versionIndex + 1] : undefined
const pathArg = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== VERSION)

const dbPath = findDb(pathArg)
const db = new Database(dbPath)

try {
	if (!APPLY) db.pragma('query_only = ON')
	console.log('db: ' + dbPath)

	const rows = db.prepare('SELECT key, value FROM meta ORDER BY key').all() as Array<{
		key: string
		value: string | null
	}>

	console.log('\n================ meta ================')
	for (const r of rows) console.log('  ' + r.key + ' = ' + String(r.value ?? ''))

	const counts = db
		.prepare('SELECT scope, COUNT(*) AS c FROM events GROUP BY scope ORDER BY scope')
		.all() as Array<{ scope: string | null; c: number }>
	const total = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c
	console.log('\n================ row counts ================')
	console.log('  total: ' + total)
	for (const c of counts) console.log('  ' + String(c.scope) + ': ' + c.c)

	const versionKeys = rows.filter((r) => /^dump-v\d/.test(String(r.value ?? '')))
	console.log('\n================ version keys ================')
	if (versionKeys.length === 0) {
		console.log('  No meta value matches dump-vX.Y.')
		console.log('  Nothing was changed. Read the list above and pass the key explicitly')
		console.log('  once you know which one /v1/meta reports.')
	} else {
		for (const k of versionKeys) console.log('  ' + k.key + ' = ' + k.value)
	}

	if (!VERSION) {
		console.log('\n  No --version given; read-only. Pass --version dump-v0.6.1 --apply to bump.')
	} else if (!/^dump-v\d+\.\d+(\.\d+)?$/.test(VERSION)) {
		console.error('\nABORT: --version must look like dump-v0.6.1. Got: ' + VERSION)
		process.exit(1)
	} else if (versionKeys.length === 0) {
		console.error('\nABORT: asked to bump to ' + VERSION + ' but no version key was found.')
		process.exit(1)
	} else {
		const upsert = db.prepare(
			'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
		)
		const stamp = db.transaction(() => {
			for (const k of versionKeys) {
				console.log('\n  ' + (APPLY ? 'bump' : 'would bump') + ' ' + k.key + ': ' + k.value + ' -> ' + VERSION)
				if (APPLY) {
					upsert.run(k.key, VERSION)
					upsert.run(k.key + '_previous', String(k.value ?? ''))
				}
			}
			if (APPLY) {
				upsert.run('dataset_stamped_at', new Date().toISOString())
				upsert.run('dataset_row_count', String(total))
				upsert.run(
					'dedupe_pass',
					'automatic co-located merge + hand verdicts from the dump-v0.6 duplicate review table',
				)
			}
		})
		stamp()
	}

	console.log(
		APPLY
			? '\n  Stamped. The dump, the release asset and the pinned DATASET_SHA256 in render.yaml must move together.'
			: '\n  DRY RUN. Nothing was written.',
	)
} finally {
	db.close()
}
