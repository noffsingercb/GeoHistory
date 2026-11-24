import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { classifyReviewedPairs, reviewedPairs } from './audit-reviewed-dupes'
import { NO_MERGE, VERDICTS } from './lib/reviewed-dupe-verdicts'
import { HISTORIC_AUTO_MERGES } from './lib/historic-auto-dupe-merges'

test('only explicit reviewed pairs are audited and repeated verdicts are grouped', () => {
  const pairs = reviewedPairs([
    { id: 'a', survivorId: 'Q1', memberIds: ['Q1', 'seed:a', 'seed:b'] },
    { id: 'b', survivorId: 'Q1', memberIds: ['Q1', 'seed:a'] },
  ])
  assert.deepEqual(pairs, [
    { survivor: 'Q1', donor: 'seed:a', verdicts: ['a', 'b'] },
    { survivor: 'Q1', donor: 'seed:b', verdicts: ['a'] },
  ])
  const actual = reviewedPairs(VERDICTS)
  assert.ok(actual.some(p => p.survivor === 'Q217450' && p.donor === 'seed:paris-1783-01-01'))
  assert.ok(NO_MERGE.some(v => v.id === 'G006'))
  assert.ok(actual.every(p => p.verdicts.every(id => !NO_MERGE.some(v => v.id === id))))
  assert.ok(actual.every(p => !p.survivor.includes('#') && !p.donor.includes('#')))
})

test('historic automatic plan contains its exact recorded 132 groups and 133 donors', () => {
  assert.equal(HISTORIC_AUTO_MERGES.length, 132)
  assert.equal(reviewedPairs(HISTORIC_AUTO_MERGES).length, 133)
  const combined = reviewedPairs([...HISTORIC_AUTO_MERGES, ...VERDICTS])
  assert.ok(combined.some(p => p.survivor === 'Q853685' && p.donor === 'seed:noteborg-1323-08-12' && p.verdicts.includes('auto:M001')))
  assert.ok(combined.every(p => !p.survivor.includes('#') && !p.donor.includes('#')))
})

test('categorizes present pairs, missing survivors, and absent donors without inferring identity', () => {
  const pairs = reviewedPairs([
    { id: 'a', survivorId: 'Q1', memberIds: ['Q1', 'seed:a', 'seed:b'] },
    { id: 'b', survivorId: 'Q2', memberIds: ['Q2', 'seed:c'] },
    { id: 'c', survivorId: 'Q3', memberIds: ['Q3', 'seed:d'] },
  ])
  const present = new Set(['Q1', 'seed:a', 'seed:c'])
  const result = classifyReviewedPairs(pairs, id => present.has(id))
  assert.deepEqual(result.bothPresent.map(p => p.donor), ['seed:a'])
  assert.deepEqual(result.donorOnly.map(p => p.donor), ['seed:c'])
  assert.equal(result.donorAbsent, 1)
  assert.equal(result.bothAbsent, 1)
})

test('rejects malformed or contradictory verdicts', () => {
  assert.throws(() => reviewedPairs([{ id: 'x', memberIds: ['Q1', 'Q2'] }]))
  assert.throws(() => reviewedPairs([{ id: 'x', survivorId: 'Q1', memberIds: ['Q1', 'Q1'] }]))
  assert.throws(() => reviewedPairs([
    { id: 'x', survivorId: 'Q1', memberIds: ['Q1', 'Q2'] },
    { id: 'y', survivorId: 'Q2', memberIds: ['Q2', 'Q3'] },
  ]))
})

test('strict CLI flags reviewed recurrence without changing the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reviewed-dupes-'))
  try {
    const path = join(dir, 'events.sqlite')
    const db = new Database(path)
    db.exec("CREATE TABLE events (id TEXT PRIMARY KEY); INSERT INTO events VALUES ('Q217450'), ('seed:paris-1783-01-01')")
    db.close()
    const before = createHash('sha256').update(readFileSync(path)).digest('hex')
    const run = (...args: string[]) => spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/audit-reviewed-dupes.ts', ...args], { env: { ...process.env, GEOHISTORY_DB: path }, encoding: 'utf8' })
    const report = run()
    assert.equal(report.status, 0, report.stderr)
    assert.ok(JSON.parse(report.stdout).bothPresent.some((p: { donor: string }) => p.donor === 'seed:paris-1783-01-01'))
    assert.equal(run('--strict').status, 1)
    assert.notEqual(run('--strcit').status, 0)
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
