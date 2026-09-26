import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  boundingBox,
  nearbyEvents,
  NearbyOverflowError,
  type NearbyDatabase,
  type NearbyInput,
} from './nearby';

const BASE_INPUT: NearbyInput = {
  lat: 0,
  lng: 0,
  radiusKm: 150,
  limit: 12,
  significanceFloor: 0.05,
  coordinateMode: 'direct',
  excludeCategories: [],
  includeUniversal: false,
};

test('bounding box contains the due-north edge of the exact circle', () => {
  const box = boundingBox(0, 0, 150);
  const exactNorthLatitude = (150 / 6371) * (180 / Math.PI);
  assert.ok(box.maxLat >= exactNorthLatitude);
  assert.ok(box.minLat <= -exactNorthLatitude);
});

test('antimeridian boxes split into two longitude ranges', () => {
  assert.equal(boundingBox(0, 179.9, 150).lngRanges.length, 2);
  assert.equal(boundingBox(0, -179.9, 150).lngRanges.length, 2);
});

test('a polar box scans every longitude', () => {
  assert.deepEqual(boundingBox(89.9, 20, 150).lngRanges, [[-180, 180]]);
});

test('date windows include a ranged event that began before the window', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, display_title TEXT, blurb TEXT,
      date_start TEXT NOT NULL, date_end TEXT, date_precision TEXT, category TEXT,
      scope TEXT, significance REAL, notability REAL, coord_source TEXT,
      lat REAL, lng REAL, source_url TEXT
    );
    CREATE INDEX idx_events_lat_lng ON events(lat, lng);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('dataset_version', 'test-v1');
    INSERT INTO meta VALUES ('scoring_version', 'score-v2');
    INSERT INTO meta VALUES ('reach_version', 'reach-v3');
    INSERT INTO meta VALUES ('last_prune', 'test prune');
    INSERT INTO events VALUES (
      'Q-range', 'Ranged event', NULL, NULL, '1890', '1905', 'year', 'event',
      'local', 0.5, 0.5, 'P625', 0, 0, 'https://example.test/Q-range'
    );
  `);
  const result = nearbyEvents(db as unknown as NearbyDatabase, {
    ...BASE_INPUT,
    radiusKm: 5,
    fromYear: 1900,
    toYear: 1901,
  });
  assert.deepEqual(result.entries.map((entry) => entry.id), ['Q-range']);
  assert.equal(result.datasetBuild, 'test-v1+score-v2+reach-v3+prune1');
  db.close();
});

test('candidate overflow fails instead of truncating', () => {
  const db: NearbyDatabase = {
    prepare: () => ({
      all: () => new Array(10001).fill({}),
      get: () => undefined,
    }),
  };
  assert.throws(() => nearbyEvents(db, BASE_INPUT), NearbyOverflowError);
});
