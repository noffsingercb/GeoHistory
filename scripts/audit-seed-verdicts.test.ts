import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { classify, parseTsv, verdictPairs } from './audit-seed-verdicts'

test('parses only exact explicit decisions and rejects malformed verdicts', () => {
  const tsv = 'verdict\tdump_id\tseed_id\ndrop-seed\tQ1\tseed:a\n'
  assert.deepEqual(verdictPairs('dupe-drop.tsv', tsv), [{survivor:'Q1', donor:'seed:a', source:'dupe-drop.tsv'}])
  assert.throws(() => verdictPairs('dupe-drop.tsv', tsv.replace('drop-seed', 'keep-both')))
  assert.throws(() => verdictPairs('dupe-keep.tsv', tsv))
  assert.throws(() => parseTsv('a\ta\nx\ty', 'x', ['a']))
  assert.throws(() => parseTsv('a\tb\nx', 'x', ['a', 'b']))
  assert.throws(() => verdictPairs('dupe-merge-universal.tsv', 'keep_id\tdonor_id\nQ1\tQ1'))
})

test('reports each presence combination, not just confirmed recurrence', () => {
  const pairs = ['a','b','c','d'].map((x,i) => ({survivor:`Q${i}`, donor:`seed:${x}`, source:'x'}))
  const ids = new Set(['Q0','seed:a','Q1','seed:c'])
  const r = classify(pairs, id => ids.has(id))
  assert.equal(r.survivorOnly, 1); assert.equal(r.bothPresent.length, 1); assert.equal(r.donorOnly.length, 1); assert.equal(r.neither.length, 1)
})

test('strict CLI flags exact reviewed recurrence, without modifying data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-verdict-audit-'))
  try {
    const path = join(dir, 'events.sqlite'), db = new Database(path)
    db.exec("CREATE TABLE events (id TEXT PRIMARY KEY); INSERT INTO events VALUES ('Q2365048'), ('seed:adal-sultanate-1415-01-01')")
    db.close()
    const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex')
    const before = hash()
    const run = (...args: string[]) => spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/audit-seed-verdicts.ts', ...args], {env: {...process.env, GEOHISTORY_DB:path}, encoding:'utf8'})
    const report = run()
    assert.equal(report.status, 0, report.stderr)
    assert.ok(JSON.parse(report.stdout).results['dupe-drop.tsv'].bothPresent.some((p: {donor:string}) => p.donor === 'seed:adal-sultanate-1415-01-01'))
    assert.equal(run('--strict').status, 1)
    assert.notEqual(run('--strcit').status, 0)
    const empty = join(dir, 'empty.sqlite'), emptyDb = new Database(empty)
    emptyDb.exec('CREATE TABLE events (id TEXT PRIMARY KEY)'); emptyDb.close()
    const missing = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/audit-seed-verdicts.ts', '--strict'], {env: {...process.env, GEOHISTORY_DB:empty}, encoding:'utf8'})
    assert.equal(missing.status, 1, 'unreviewed neither-present pairs must fail strict mode')
    assert.equal(hash(), before)
  } finally { rmSync(dir, {recursive:true, force:true}) }
})
