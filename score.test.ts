import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

function runFixture(
  mode: 'all' | 'scores' | 'reach',
  datasetVersion?: string | null,
  ingestVersions?: Array<string | null>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'geohistory-score-'));
  const path = join(dir, 'test.sqlite');
  try {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, category TEXT, notability REAL, date_start TEXT,
        scope TEXT, ingest_version TEXT, blurb TEXT, coord_source TEXT,
        lat REAL, lng REAL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO events VALUES ('Q1', 'event', 0.5, '1900', 'regional', 'dump-v0.6', NULL, 'P625', 39, -105);
      INSERT INTO events VALUES ('Q2', 'event', 0.4, '1901', 'local', 'dump-v0.6', NULL, 'P625', 40, -105);
      INSERT INTO events VALUES ('Q3', 'event', 0.3, '1902', 'local', 'seed-v1', NULL, 'P625', 40, -105);
    `);
    if (datasetVersion !== undefined) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('dataset_version', datasetVersion);
    }
    if (ingestVersions) {
      const update = db.prepare('UPDATE events SET ingest_version = ? WHERE id = ?');
      ingestVersions.forEach((version, index) => update.run(version, `Q${index + 1}`));
    }
    db.close();

    const result = spawnSync(process.execPath, ['--import', 'tsx', 'score.ts', mode], {
      cwd: process.cwd(),
      env: { ...process.env, GEOHISTORY_DB: path },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `score ${mode} failed:\n${result.stdout}\n${result.stderr}`);
    const scored = new Database(path, { readonly: true });
    const rows = scored.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string | null }>;
    scored.close();
    return { meta: Object.fromEntries(rows.map(({ key, value }) => [key, value])), output: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const mode of ['all', 'scores', 'reach'] as const) {
  test(`${mode}: preserves curated dataset identity and reports modal ingest`, () => {
    const { meta, output } = runFixture(mode, 'dump-v0.6.1');
    assert.equal(meta.dataset_version, 'dump-v0.6.1');
    assert.equal(meta.ingest_version_modal, 'dump-v0.6');
    assert.match(output, /dataset_version left at dump-v0\.6\.1.*dump-v0\.6/);
  });
}

test('a missing dataset version is initialized from the modal ingest version', () => {
  const { meta } = runFixture('all');
  assert.equal(meta.dataset_version, 'dump-v0.6');
  assert.equal(meta.ingest_version_modal, 'dump-v0.6');
});

test('an existing dataset version equal to the modal value remains unchanged', () => {
  const { meta } = runFixture('all', 'dump-v0.6');
  assert.equal(meta.dataset_version, 'dump-v0.6');
  assert.equal(meta.ingest_version_modal, 'dump-v0.6');
});

for (const value of ['', null]) {
  test(`an existing ${String(value)} dataset version is not treated as missing`, () => {
    const { meta } = runFixture('all', value);
    assert.equal(meta.dataset_version, value);
    assert.equal(meta.ingest_version_modal, 'dump-v0.6');
  });
}

test('null and empty ingest versions do not mask a valid modal version', () => {
  const { meta } = runFixture('all', undefined, [null, '', 'seed-v1']);
  assert.equal(meta.dataset_version, 'seed-v1');
  assert.equal(meta.ingest_version_modal, 'seed-v1');
});

test('without a usable ingest version, no published label is invented', () => {
  const { meta } = runFixture('all', undefined, [null, '', null]);
  assert.equal(meta.dataset_version, undefined);
  assert.equal(meta.ingest_version_modal, undefined);
});