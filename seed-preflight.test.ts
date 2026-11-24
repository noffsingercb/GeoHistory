import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { missingPromotions } from './scripts/audit-universal-promotions';

const seeds = JSON.parse(readFileSync('seed/universal-v0.1.json', 'utf8'));
const qids = missingPromotions(seeds, () => false).map(row => row.qid);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'seed-preflight-'));
  const dbPath = join(dir, 'events.sqlite');
  const exceptions = join(dir, 'exceptions.json');
  const db = new Database(dbPath);
  db.exec(readFileSync('schema.sql', 'utf8'));
  const insert = db.prepare("INSERT INTO events (id,title,date_start,ingest_version) VALUES (?, 'Existing dump event', '1900', 'dump-test')");
  for (const qid of qids.slice(1)) insert.run(qid);
  db.close();
  writeFileSync(exceptions, '[]');
  const env = { ...process.env, GEOHISTORY_DB: dbPath, UNIVERSAL_FALLBACK_EXCEPTIONS: exceptions };
  const run = (...args: string[]) => spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'seed.ts', ...args], { env, encoding: 'utf8' });
  const hash = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  return { dir, dbPath, exceptions, run, hash };
}

test('strict seed refuses an unreviewed promotion before changing the database', () => {
  const f = fixture();
  try {
    const before = f.hash();
    const result = f.run('--strict-fallbacks');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(qids[0]));
    assert.equal(f.hash(), before);
    assert.equal(existsSync(f.dbPath + '-wal'), false);
    assert.equal(existsSync(f.dbPath + '-shm'), false);
    const db = new Database(f.dbPath, { readonly: true, fileMustExist: true });
    try { assert.equal(db.pragma('journal_mode', { simple: true }), 'delete'); } finally { db.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('strict seed accepts a specific reviewed fallback and promotes present QIDs', () => {
  const f = fixture();
  try {
    writeFileSync(f.exceptions, JSON.stringify([{ qid: qids[0], reason: 'Synthetic fixture: absent on purpose' }]));
    const result = f.run('--strict-fallbacks');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const db = new Database(f.dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT scope FROM events WHERE id = ?').get(qids[1]) as { scope: string };
      assert.equal(row.scope, 'universal');
      const fallback = db.prepare("SELECT COUNT(*) AS n FROM events WHERE id LIKE 'universal:%' AND source_ids LIKE ?").get(`%${qids[0]}%`) as { n: number };
      assert.equal(fallback.n, 1);
    } finally { db.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('strict seed fails closed for malformed exception files and unrecognized flags', () => {
  const f = fixture();
  try {
    const before = f.hash();
    writeFileSync(f.exceptions, '{invalid');
    assert.notEqual(f.run('--strict-fallbacks').status, 0);
    assert.equal(f.hash(), before);
    assert.notEqual(f.run('--strict-fallbaks').status, 0);
    assert.equal(f.hash(), before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('strict seed does not create a missing database', () => {
  const f = fixture();
  try {
    rmSync(f.dbPath);
    assert.notEqual(f.run('--strict-fallbacks').status, 0);
    assert.equal(existsSync(f.dbPath), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
