import assert from 'node:assert/strict';
import test from 'node:test';
import { missingPromotions, reviewFallbacks } from './audit-universal-promotions';

test('reports missing promotions but excludes existing, deliberate inserts and non-universal rows', () => {
  const rows = [
    { Title: 'Present', Wikidata: 'Q1', Tier: 'universal' },
    { Title: 'Missing', Wikidata: 'Q2', Tier: 'universal', Action: 'promote' as const },
    { Title: 'Intentional insert', Wikidata: 'Q3', Tier: 'universal', Action: 'insert' as const },
    { Title: 'Ordinary', Wikidata: 'Q4' },
    { Title: '   ', Wikidata: 'Q5', Tier: 'universal' }, // skipped by seed loader
  ];
  assert.deepEqual(missingPromotions(rows, qid => qid === 'Q1'), [{ qid: 'Q2', title: 'Missing' }]);
});


test('strict review separates explicit exceptions from unreviewed misses', () => {
  const missing = [{ qid: 'Q1', title: 'Expected' }, { qid: 'Q2', title: 'Unknown' }];
  assert.deepEqual(reviewFallbacks(missing, [{ qid: 'Q1', reason: 'Reviewed and documented' }], new Set(['Q1', 'Q2'])), {
    expected: [{ qid: 'Q1', title: 'Expected', reason: 'Reviewed and documented' }], unreviewed: [{ qid: 'Q2', title: 'Unknown' }],
  });
});

test('exceptions must be specific, justified, unique and refer to promotion seeds', () => {
  const eligible = new Set(['Q1']);
  for (const list of [
    [{ qid: 'Q1', reason: ' ' }], [{ qid: 'Q2', reason: 'not a seed' }],
    [{ qid: 'not-a-qid', reason: 'bad id' }], [{ qid: 'Q1', reason: 'a' }, { qid: 'Q1', reason: 'b' }],
  ]) assert.throws(() => reviewFallbacks([], list, eligible));
});

test('CLI strict mode rejects an unreviewed missing QID and accepts a reviewed exception', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { default: Database } = await import('better-sqlite3');
  const tmp = mkdtempSync(join(tmpdir(), 'universal-audit-'));
  try {
    const dbPath = join(tmp, 'events.sqlite');
    const exceptionsPath = join(tmp, 'exceptions.json');
    const seeds = JSON.parse(readFileSync('seed/universal-v0.1.json', 'utf8'));
    const qids = missingPromotions(seeds, () => false).map(row => row.qid);
    const db = new Database(dbPath);
    db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, ingest_version TEXT)');
    const insert = db.prepare("INSERT INTO events VALUES (?, 'dump-v0.6')");
    for (const qid of qids.slice(1)) insert.run(qid);
    db.close();
    const env = { ...process.env, GEOHISTORY_DB: dbPath, UNIVERSAL_FALLBACK_EXCEPTIONS: exceptionsPath };
    const run = (args: string[]) => spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/audit-universal-promotions.ts', ...args], { env, encoding: 'utf8' });
    writeFileSync(exceptionsPath, '[]');
    assert.equal(run([]).status, 0, 'inventory mode never claims a reviewed outcome');
    const failed = run(['--strict']);
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).unreviewed[0].qid, qids[0]);
    writeFileSync(exceptionsPath, JSON.stringify([{ qid: qids[0], reason: 'Test-only reviewed fallback' }]));
    const passed = run(['--strict']);
    assert.equal(passed.status, 0);
    assert.equal(JSON.parse(passed.stdout).expected[0].qid, qids[0]);
    assert.equal(run(['--strcit']).status === 0, false, 'unknown options must not silently disable strict mode');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
