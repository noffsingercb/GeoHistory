import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

test('date diagnostic opens an existing DELETE-mode database without altering it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'date-diag-'));
  try {
    const file = join(dir, 'events.sqlite');
    const db = new Database(file);
    db.pragma('journal_mode = DELETE');
    db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, display_title TEXT, blurb TEXT, date_start TEXT, date_end TEXT, scope TEXT, significance REAL); INSERT INTO events VALUES ('Q1', 'Example', NULL, 'War, 1900–1905', '1900', NULL, 'national', 0.5);`);
    db.close();
    const sha = () => createHash('sha256').update(readFileSync(file)).digest('hex');
    const before = sha();
    const run = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'diagnose-date-ranges.ts'], { env: { ...process.env, GEOHISTORY_DB: file }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /total flagged: 1/);
    assert.match(run.stdout, /read-only/);
    assert.equal(sha(), before);
    assert.equal(existsSync(file + '-wal'), false);
    assert.equal(existsSync(file + '-shm'), false);
    const verify = new Database(file, { readonly: true, fileMustExist: true });
    try { assert.equal(verify.pragma('journal_mode', { simple: true }), 'delete'); } finally { verify.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
