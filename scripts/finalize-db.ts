/**
 * finalize-db.ts - make events.sqlite safe to upload, then checksum it.
 *
 *   npx tsx scripts/finalize-db.ts             -> checkpoint, verify, checksum
 *   npx tsx scripts/finalize-db.ts --vacuum    -> also VACUUM (slow, ~995MB)
 *
 * Why this exists: dupe-merge-apply.ts and dupe-merge-manual.ts set
 * journal_mode = WAL while writing. WAL is a property of the FILE, not of the
 * connection, so it survives the process and leaves events.sqlite-wal and
 * events.sqlite-shm next to the database. Anything that copies or uploads
 * events.sqlite alone can therefore publish a database that is missing
 * committed rows -- and every local count will still look right, because
 * local readers see the WAL. That is the same class of silent failure as the
 * cached Docker layer: a green result reported over stale data.
 *
 * So: checkpoint the WAL into the main file, put the file back into rollback
 * journalling, prove the database and the FTS index are intact, and print the
 * size and SHA-256 that must go into render.yaml.
 */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { findDb } from './lib/dupe-plan.js'

const VACUUM = process.argv.includes('--vacuum')
const dbPath = findDb(process.argv.slice(2).find((a) => !a.startsWith('--')))
console.log('db: ' + dbPath + '\n')

let failures = 0
const check = (label: string, ok: boolean, detail: string) => {
	if (!ok) failures++
	console.log((ok ? '  PASS  ' : '  FAIL  ') + label + ' -- ' + detail)
}

const db = new Database(dbPath)

console.log('================ 1. CHECKPOINT ================')
console.log('  journal_mode before: ' + (db.pragma('journal_mode', { simple: true }) as string))
const cp = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number; checkpointed: number }>
if (cp.length > 0) {
	check('WAL fully checkpointed', cp[0].busy === 0, 'busy=' + cp[0].busy + ' log=' + cp[0].log + ' checkpointed=' + cp[0].checkpointed)
}
const after = db.pragma('journal_mode = delete', { simple: true }) as string
check('journal_mode returned to rollback', after === 'delete', after)

if (VACUUM) {
	console.log('\n  VACUUM running, this takes a while on a ~1GB file...')
	db.exec('VACUUM')
	console.log('  VACUUM done.')
}

console.log('\n================ 2. INTEGRITY ================')
const integrity = db.pragma('integrity_check', { simple: true }) as string
check('sqlite integrity_check', integrity === 'ok', integrity)
try {
	db.prepare("INSERT INTO events_fts(events_fts) VALUES('integrity-check')").run()
	check('events_fts integrity-check', true, 'ok')
} catch (err) {
	check('events_fts integrity-check', false, String(err))
}

const total = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c
const universal = (db.prepare("SELECT COUNT(*) AS c FROM events WHERE scope = 'universal'").get() as { c: number }).c
const version = (db.prepare("SELECT value FROM meta WHERE key = 'dataset_version'").get() as { value: string } | undefined)?.value
console.log('  rows: ' + total + '   universal: ' + universal + '   dataset_version: ' + version)
db.close()

console.log('\n================ 3. SIDECARS ================')
for (const suffix of ['-wal', '-shm']) {
	const p = dbPath + suffix
	const present = existsSync(p)
	check('no ' + suffix + ' file left behind', !present, present ? 'STILL PRESENT at ' + p : 'absent')
}

console.log('\n================ 4. CHECKSUM ================')
const size = statSync(dbPath).size
const hash = createHash('sha256')
const stream = createReadStream(dbPath)
stream.on('data', (chunk) => hash.update(chunk))
stream.on('end', () => {
	const digest = hash.digest('hex')
	console.log('  bytes:  ' + size.toLocaleString('en-US') + '  (' + size + ')')
	console.log('  sha256: ' + digest)
	console.log('\n================ RESULT ================')
	if (failures === 0) {
		console.log('Safe to upload. Next:')
		console.log('  gh release upload dataset-latest "' + dbPath + '" --clobber')
		console.log('Then set DATASET_SHA256 in render.yaml to the sha256 above,')
		console.log('confirm it matches the asset digest GitHub reports, and')
		console.log('commit that change to main in the SAME commit as any code change.')
	} else {
		console.log(failures + ' CHECK(S) FAILED - do not upload.')
	}
	process.exit(failures === 0 ? 0 : 1)
})
