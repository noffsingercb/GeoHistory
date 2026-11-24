import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  boundingBox,
  validateNearbyInput,
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


test('expanded bounds accept 200 km and 500 entries, but reject larger requests', () => {
  const input = { lat: 0, lng: 0, radiusKm: 200, limit: 100 };
  assert.equal(validateNearbyInput(input).limit, 100);
  assert.throws(() => validateNearbyInput({ ...input, radiusKm: 200.01 }));
  assert.equal(validateNearbyInput({ ...input, limit: 500 }).limit, 500);
  assert.throws(() => validateNearbyInput({ ...input, limit: 501 }));
  assert.equal(validateNearbyInput({ lat: 0, lng: 0, radiusKm: 5 }).limit, 12);
});

test('large result sets select nearest 100 then return them in date order', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, display_title TEXT, blurb TEXT, date_start TEXT NOT NULL, date_end TEXT, date_precision TEXT, category TEXT, scope TEXT, significance REAL, notability REAL, coord_source TEXT, lat REAL, lng REAL, source_url TEXT); CREATE INDEX idx_events_lat_lng ON events(lat, lng); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const insert = db.prepare(`INSERT INTO events VALUES (?, ?, NULL, NULL, ?, NULL, 'year', 'event', 'local', 0.5, 0.5, 'P625', 0, ?, 'https://example.test')`);
  for (let i = 0; i < 101; i++) insert.run(`Q${i}`, `Event ${i}`, String(1900 + (100 - i)), i / 1000);
  const result = nearbyEvents(db as unknown as NearbyDatabase, { ...BASE_INPUT, radiusKm: 200, limit: 100 });
  assert.equal(result.totalWithinRadius, 101);
  assert.equal(result.returned, 100);
  assert.equal(result.entries.some(e => e.id === 'Q100'), false);
  assert.equal(result.entries[0].id, 'Q99');
  assert.equal(result.entries.at(-1)?.id, 'Q0');
  db.close();
});


test('offset pages partition nearest results deterministically and retain date order', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, display_title TEXT, blurb TEXT, date_start TEXT NOT NULL, date_end TEXT, date_precision TEXT, category TEXT, scope TEXT, significance REAL, notability REAL, coord_source TEXT, lat REAL, lng REAL, source_url TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const insert = db.prepare(`INSERT INTO events VALUES (?, ?, NULL, NULL, ?, NULL, 'year', 'event', 'local', 0.5, 0.5, 'P625', 0, ?, 'https://example.test')`);
  for (let i = 0; i < 61; i++) insert.run(`Q${i}`, `Event ${i}`, String(2000 - i), i / 1000);
  const pages = [0, 25, 50].map(offset => nearbyEvents(db as unknown as NearbyDatabase, { ...BASE_INPUT, limit: 25, offset }));
  assert.deepEqual(pages.map(p => p.returned), [25, 25, 11]);
  assert.deepEqual(pages.map(p => p.offset), [0, 25, 50]);
  assert.equal(new Set(pages.flatMap(p => p.entries.map(e => e.id))).size, 61);
  assert.deepEqual(pages[1].entries.map(e => e.id), Array.from({length:25}, (_,i) => `Q${49-i}`));
  assert.equal(validateNearbyInput({lat:0,lng:0,radiusKm:5}).offset, 0);
  for (const offset of [-1, 10000, 1.2, '25']) assert.throws(() => validateNearbyInput({lat:0,lng:0,radiusKm:5,offset}));
  db.close();
});

test('chronological pages sort all filtered matches before slicing, with deterministic ties', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, display_title TEXT, blurb TEXT, date_start TEXT NOT NULL, date_end TEXT, date_precision TEXT, category TEXT, scope TEXT, significance REAL, notability REAL, coord_source TEXT, lat REAL, lng REAL, source_url TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const insert = db.prepare(`INSERT INTO events VALUES (?, ?, NULL, NULL, ?, NULL, 'year', ?, 'local', ?, 0.5, 'P625', 0, ?, 'https://example.test')`);
  for (let i = 0; i < 61; i++) insert.run(`Q${i}`, `Event ${i}`, String(2000-i), i % 2 ? 'event' : 'treaty', i % 3 ? 0.95 : 0.5, i / 1000);
  const options: NearbyInput = { ...BASE_INPUT, limit: 25, order: 'chronological' };
  const pages = [0,25,50].map(offset => nearbyEvents(db as unknown as NearbyDatabase, { ...options, offset }));
  assert.deepEqual(pages.map(p => p.returned), [25,25,11]);
  assert.ok(pages.every(p => p.order === 'chronological'));
  assert.deepEqual(pages.flatMap(p => p.entries.map(e => e.id)), Array.from({length:61}, (_,i) => `Q${60-i}`));
  const filtered = nearbyEvents(db as unknown as NearbyDatabase, { ...options, significanceFloor: 0.9, excludeCategories: ['treaty'] });
  assert.ok(filtered.entries.every(e => e.category === 'event' && (e.significance ?? 0) >= 0.9));
  assert.equal(validateNearbyInput({lat:0,lng:0,radiusKm:5}).order, 'nearest');
  assert.equal(validateNearbyInput({lat:0,lng:0,radiusKm:5,order:'chronological'}).order, 'chronological');
  assert.throws(() => validateNearbyInput({lat:0,lng:0,radiusKm:5,order:'bogus'}));
  insert.run('T-c', 'Tie c', '1800', 'event', 0.95, 0.01);
  insert.run('T-b', 'Tie b', '1800', 'event', 0.95, 0);
  insert.run('T-a', 'Tie a', '1800', 'event', 0.95, 0);
  const ties = nearbyEvents(db as unknown as NearbyDatabase, { ...options, limit: 5 });
  assert.deepEqual(ties.entries.slice(0,3).map(e => e.id), ['T-a', 'T-b', 'T-c']);
  db.close();
});

test('500-entry chronological batches compose one ordered complete result set', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, display_title TEXT, blurb TEXT, date_start TEXT NOT NULL, date_end TEXT, date_precision TEXT, category TEXT, scope TEXT, significance REAL, notability REAL, coord_source TEXT, lat REAL, lng REAL, source_url TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const insert = db.prepare(`INSERT INTO events VALUES (?, ?, NULL, NULL, ?, NULL, 'year', 'event', 'local', 0.5, 0.5, 'P625', 0, ?, 'https://example.test')`);
  for (let i = 0; i < 549; i++) insert.run(`Q${i}`, `Event ${i}`, String(2000 - i), i / 10000);
  const options: NearbyInput = { ...BASE_INPUT, limit: 500, order: 'chronological' };
  const pages = [0, 500].map(offset => nearbyEvents(db as unknown as NearbyDatabase, { ...options, offset }));
  assert.deepEqual(pages.map(p => p.returned), [500, 49]);
  assert.deepEqual(pages.flatMap(p => p.entries.map(e => e.id)), Array.from({ length: 549 }, (_, i) => `Q${548 - i}`));
  db.close();
});

test('people mode admits only matching approximate birth/death places, never unrelated fallback locations', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, display_title TEXT, blurb TEXT, date_start TEXT NOT NULL, date_end TEXT, date_precision TEXT, category TEXT, scope TEXT, significance REAL, notability REAL, coord_source TEXT, lat REAL, lng REAL, source_url TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  const insert = db.prepare(`INSERT INTO events VALUES (?, ?, NULL, NULL, '1900', NULL, 'year', ?, 'local', 0.9, 0.5, ?, 0, 0, 'https://example.test')`);
  insert.run('direct', 'Direct', 'event', 'P625');
  insert.run('birth-place', 'Birth', 'birth', 'P19');
  insert.run('death-place', 'Death', 'death', 'P20');
  insert.run('other-fallback', 'Other', 'event', 'P17');
  insert.run('wrong-category', 'Wrong', 'event', 'P19');
  insert.run('wrong-place', 'Wrong', 'birth', 'P20');
  const direct = nearbyEvents(db as unknown as NearbyDatabase, { ...BASE_INPUT, radiusKm: 5 });
  assert.deepEqual(direct.entries.map(e => e.id), ['direct']);
  const people = nearbyEvents(db as unknown as NearbyDatabase, { ...BASE_INPUT, radiusKm: 5, coordinateMode: 'direct-with-people' });
  assert.deepEqual(people.entries.map(e => e.id), ['birth-place', 'death-place', 'direct']);
  const withoutPeople = nearbyEvents(db as unknown as NearbyDatabase, { ...BASE_INPUT, radiusKm: 5, coordinateMode: 'direct-with-people', excludeCategories: ['birth','death'] });
  assert.deepEqual(withoutPeople.entries.map(e => e.id), ['direct']);
  assert.equal(validateNearbyInput({lat:0,lng:0,radiusKm:5,coordinateMode:'direct-with-people'}).coordinateMode, 'direct-with-people');
  db.close();
});
