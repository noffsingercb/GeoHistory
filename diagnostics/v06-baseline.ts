import Database from 'better-sqlite3';

// ===================== v0.6 baseline diagnostics (read-only) =====================
// Prints the numbers the "rescore & re-ingest for core DB v0.6" sprint needs
// BEFORE any scoring, title, or ingest change lands, so every change in the
// sprint can be measured against one baseline afterwards. Complements stats.ts,
// which reports composition only; this file asks the sprint's questions.
//
//   npx tsx diagnostics/v06-baseline.ts              # every section
//   npx tsx diagnostics/v06-baseline.ts F G H        # only the named sections
//
// Sections
//   A  provenance + composition (meta, ingest_version, category, scope, precision)
//   B  scope x category matrix
//   C  founding_kind vs scope (is any settlement founding still national/global?)
//   D  seed layer health (counts, rows the engine cannot place, date_end use, bare titles)
//   E  rows the engine can never return (null coords / null reach) -- famous ones listed
//   F  era skew: global share + notability by decade; the top recent 'global' rows
//   G  anchor events: are the world wars, pandemics, depressions in the file at all?
//   H  fixture probe: candidate rows per year around one coordinate (finds empty spans)
//   I  title hygiene: 'Discovery of <building>', ambiguous settlement names, bare person names
//
// Env
//   GEOHISTORY_DB   path to the database (default events.sqlite)
//   DIAG_LAT/LNG    section H probe point (default Cincinnati, 39.1031 / -84.5120)
//   DIAG_FROM/TO    section H year window (default 1925-1950)
//
// Opens the database read-only. Writes nothing. Safe to run on the shipped file.
// Every threshold quoted here (scope ladder 0.6, per-tier floors) is a hand-copied
// mirror of score.ts / core.ts for REPORTING; the engine remains the source of truth.

const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';
const db = new Database(DB_PATH, { readonly: true });

const argv = process.argv.slice(2).map((a) => a.toUpperCase());
const want = (s: string): boolean => argv.length === 0 || argv.includes(s);

type Row = Record<string, any>;
const all = (sql: string, ...params: unknown[]): Row[] => db.prepare(sql).all(...params) as Row[];
const one = (sql: string, ...params: unknown[]): Row => (db.prepare(sql).get(...params) ?? {}) as Row;

const cols = new Set<string>((all(`PRAGMA table_info(events)`) as Array<{ name: string }>).map((c) => c.name));
const has = (c: string): boolean => cols.has(c);
// Select a column if the build has it, else a NULL placeholder with the same alias.
const col = (c: string, alias: string = c): string => (has(c) ? `${c} AS ${alias}` : `NULL AS ${alias}`);

const num = (n: number | null | undefined): string => Number(n ?? 0).toLocaleString();
const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const r3 = (x: number | null | undefined): number | null => (x == null ? null : Math.round(x * 1000) / 1000);
const section = (id: string, title: string): void => {
  console.log(`\n\n=== ${id}. ${title} ===`);
};

const YEAR = `CAST(substr(date_start, 1, 4) AS INTEGER)`;
const DECADE = `(${YEAR} / 10) * 10`;
const IS_SEED = `ingest_version LIKE 'seed-%'`;
const IS_PERSON = `category IN ('birth', 'death')`;
const SCOPES: readonly string[] = ['local', 'regional', 'national', 'global'];

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return r3(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** rows of {k, scope, n} -> one row per k with a column per scope. */
function pivotByScope(rows: Row[], keyName: string): Row[] {
  const map = new Map<string, Row>();
  for (const r of rows) {
    const k = String(r.k ?? '(null)');
    const row: Row = map.get(k) ?? { [keyName]: k, local: 0, regional: 0, national: 0, global: 0, unscored: 0, total: 0 };
    const s = SCOPES.includes(r.scope) ? (r.scope as string) : 'unscored';
    row[s] += r.n;
    row.total += r.n;
    map.set(k, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

console.log(`v06-baseline: ${DB_PATH} (read-only)`);
console.log(`events columns: ${[...cols].join(', ')}`);

// ===================== A. provenance + composition =====================
if (want('A')) {
  section('A', 'Provenance + composition');
  const total = one(`SELECT COUNT(*) AS c FROM events`).c as number;
  console.log(`Total events: ${num(total)}`);
  console.log('\nmeta:');
  for (const r of all(`SELECT key, value FROM meta ORDER BY key`)) console.log(`  ${r.key} = ${r.value}`);
  console.log('\nBy ingest_version:');
  console.table(all(`SELECT COALESCE(ingest_version, '(null)') AS ingest_version, COUNT(*) AS n FROM events GROUP BY 1 ORDER BY 2 DESC`));
  console.log('By category:');
  console.table(all(`SELECT COALESCE(category, '(null)') AS category, COUNT(*) AS n FROM events GROUP BY 1 ORDER BY 2 DESC`));
  console.log('By scope:');
  console.table(all(`SELECT COALESCE(scope, '(unscored)') AS scope, COUNT(*) AS n FROM events GROUP BY 1 ORDER BY 2 DESC`));
  console.log('By date precision:');
  console.table(all(`SELECT COALESCE(date_precision, '(null)') AS precision, COUNT(*) AS n FROM events GROUP BY 1 ORDER BY 2 DESC`));
  if (has('date_end')) {
    const de = one(`SELECT COUNT(*) AS c FROM events WHERE date_end IS NOT NULL`).c as number;
    console.log(`Rows with a date_end (multi-day/multi-year): ${num(de)} of ${num(total)} (${pct(de, total)})`);
  } else {
    console.log('No date_end column in this build.');
  }
}

// ===================== B. scope x category =====================
if (want('B')) {
  section('B', 'Scope x category');
  console.table(pivotByScope(all(`SELECT COALESCE(category, '(null)') AS k, scope, COUNT(*) AS n FROM events GROUP BY 1, 2`), 'category'));
}

// ===================== C. founding_kind vs scope =====================
if (want('C')) {
  section('C', 'Founding kinds vs scope');
  if (!has('founding_kind')) {
    console.log('No founding_kind column: run `npm run rescope:foundings` first.');
  } else {
    console.table(
      pivotByScope(
        all(`SELECT COALESCE(founding_kind, '(unclassified)') AS k, scope, COUNT(*) AS n FROM events WHERE category = 'founding' GROUP BY 1, 2`),
        'founding_kind',
      ),
    );
    const f = one(`SELECT COUNT(*) AS c FROM events WHERE category = 'founding'`).c as number;
    const fl = one(`SELECT COUNT(*) AS c FROM events WHERE category = 'founding' AND scope = 'local'`).c as number;
    console.log(`founding rows scoped local: ${num(fl)} of ${num(f)} (${pct(fl, f)})`);

    const leak = all(`SELECT id, title, scope, notability, substr(blurb, 1, 70) AS blurb FROM events WHERE category = 'founding' AND founding_kind = 'settlement' AND scope <> 'local' ORDER BY notability DESC LIMIT 15`);
    const leakN = one(`SELECT COUNT(*) AS c FROM events WHERE category = 'founding' AND founding_kind = 'settlement' AND scope <> 'local'`).c as number;
    console.log(`\nsettlement foundings NOT scoped local: ${num(leakN)} (should be 0 after rescope + score)`);
    if (leak.length) console.table(leak);

    console.log('\nTop unclassified foundings by notability (these keep the old notability-ladder scope):');
    console.table(all(`SELECT id, title, scope, notability, substr(blurb, 1, 70) AS blurb FROM events WHERE category = 'founding' AND founding_kind IS NULL ORDER BY notability DESC LIMIT 15`));
  }
}

// ===================== D. seed layer =====================
if (want('D')) {
  section('D', 'Seed layer health');
  console.table(pivotByScope(all(`SELECT ingest_version AS k, scope, COUNT(*) AS n FROM events WHERE ${IS_SEED} GROUP BY 1, 2`), 'ingest_version'));

  const unplaced = all(`SELECT id, title, date_start, scope, category, notability FROM events WHERE ${IS_SEED} AND (lat IS NULL OR lng IS NULL) ORDER BY notability DESC`);
  console.log(`\nSeed rows with no coordinates (core.ts skips these -- they never appear): ${num(unplaced.length)}`);
  if (unplaced.length) console.table(unplaced.slice(0, 25));

  if (has('date_end')) {
    const de = one(`SELECT COUNT(*) AS c FROM events WHERE ${IS_SEED} AND date_end IS NOT NULL`).c as number;
    console.log(`Seed rows with date_end: ${num(de)} (seed.ts does not write date_end today, so expect 0)`);
  }

  console.log('\nShortest seed-timeline titles (the bare-title problem; blurb is what the reader needed):');
  console.table(all(`SELECT title, date_start, scope, substr(blurb, 1, 90) AS blurb FROM events WHERE ingest_version LIKE 'seed-timeline-%' ORDER BY length(title) ASC, notability DESC LIMIT 25`));
}

// ===================== E. unreachable rows =====================
if (want('E')) {
  section('E', 'Rows the engine can never return');
  console.log('Null coordinates by scope/category:');
  console.table(all(`SELECT COALESCE(scope, '(unscored)') AS scope, COALESCE(category, '(null)') AS category, COUNT(*) AS n FROM events WHERE lat IS NULL OR lng IS NULL GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`));
  if (has('reach_km')) {
    console.log('Null reach_km by scope (score.ts pass 2 skipped them):');
    console.table(all(`SELECT COALESCE(scope, '(unscored)') AS scope, COUNT(*) AS n FROM events WHERE reach_km IS NULL GROUP BY 1 ORDER BY n DESC`));
  }
  const reachClause = has('reach_km') ? ' OR reach_km IS NULL' : '';
  console.log('\nFamous but unreturnable (notability >= 0.5):');
  console.table(all(`SELECT id, title, date_start, scope, category, notability, lat, lng, ${col('reach_km')} FROM events WHERE (lat IS NULL OR lng IS NULL${reachClause}) AND notability >= 0.5 ORDER BY notability DESC LIMIT 20`));
}

// ===================== F. era skew =====================
if (want('F')) {
  section('F', 'Era skew: scope ladder vs decade (dump rows, persons excluded)');
  const base = `FROM events WHERE NOT (${IS_SEED}) AND NOT (${IS_PERSON}) AND notability IS NOT NULL`;
  const perDecade = all(`
    SELECT CASE WHEN ${YEAR} < 1700 THEN 1000 ELSE ${DECADE} END AS decade,
           COUNT(*) AS n,
           SUM(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) AS global_n,
           SUM(CASE WHEN scope = 'national' THEN 1 ELSE 0 END) AS national_n,
           SUM(CASE WHEN notability >= 0.6 THEN 1 ELSE 0 END) AS n_ge_060,
           SUM(CASE WHEN category = 'event' AND scope = 'global' THEN 1 ELSE 0 END) AS event_global_n,
           SUM(CASE WHEN category = 'conflict' AND scope = 'global' THEN 1 ELSE 0 END) AS conflict_global_n
    ${base}
    GROUP BY 1 ORDER BY 1`);
  const byDecade = new Map<number, number[]>();
  for (const r of all(`SELECT CASE WHEN ${YEAR} < 1700 THEN 1000 ELSE ${DECADE} END AS decade, notability ${base}`)) {
    const arr = byDecade.get(r.decade) ?? [];
    arr.push(r.notability as number);
    byDecade.set(r.decade, arr);
  }
  console.table(
    perDecade.map((r) => {
      const sorted = (byDecade.get(r.decade) ?? []).sort((a, b) => a - b);
      return {
        decade: r.decade === 1000 ? '<1700' : `${r.decade}s`,
        n: r.n,
        global_share: pct(r.global_n, r.n),
        national_share: pct(r.national_n, r.n),
        ge_060_share: pct(r.n_ge_060, r.n),
        median_notab: quantile(sorted, 0.5),
        p90_notab: quantile(sorted, 0.9),
        event_global: r.event_global_n,
        conflict_global: r.conflict_global_n,
      };
    }),
  );
  console.log('Read: if global_share / p90 climb steeply after ~1990 while the ladder is fixed at raw notability, that is the recency skew.');

  console.log('\nTop dump rows scoped GLOBAL since 2006:');
  console.table(all(`SELECT id, title, category, date_start, notability, ${col('significance')} FROM events WHERE NOT (${IS_SEED}) AND scope = 'global' AND ${YEAR} >= 2006 ORDER BY notability DESC LIMIT 25`));
  console.log('Top dump rows scoped GLOBAL 1950-2005 (for comparison):');
  console.table(all(`SELECT id, title, category, date_start, notability, ${col('significance')} FROM events WHERE NOT (${IS_SEED}) AND scope = 'global' AND ${YEAR} BETWEEN 1950 AND 2005 ORDER BY notability DESC LIMIT 25`));
  console.log('Global rows per year, 1990-present (dump rows):');
  console.table(all(`SELECT ${YEAR} AS y, COUNT(*) AS global_n FROM events WHERE NOT (${IS_SEED}) AND scope = 'global' AND ${YEAR} >= 1990 GROUP BY 1 ORDER BY 1`));
}

// ===================== G. anchor events =====================
if (want('G')) {
  section('G', 'Anchor events (universal-tier candidates): present in the file?');
  // Wikidata ids for the events every timeline in the window should be able to show.
  const ANCHORS: Record<string, string> = {
    Q2487: "Thirty Years' War",
    Q33143: "Seven Years' War",
    Q160077: 'Fall of Constantinople',
    Q6534: 'French Revolution',
    Q78994: 'Napoleonic Wars',
    Q8676: 'American Civil War',
    Q361: 'World War I',
    Q178275: 'Spanish flu pandemic',
    Q8698: 'Great Depression',
    Q362: 'World War II',
    Q8683: 'Cold War',
    Q8663: 'Korean War',
    Q128160: 'Cuban Missile Crisis',
    Q8740: 'Vietnam War',
    Q43653: 'Apollo 11',
    Q486: 'Chernobyl disaster',
    Q10806: 'September 11 attacks',
    Q81068910: 'COVID-19 pandemic',
  };
  const ids = Object.keys(ANCHORS);
  const found = new Map<string, Row>();
  for (const r of all(`SELECT id, title, date_start, ${col('date_end')}, scope, category, notability, lat, lng, ${col('reach_km')}, ingest_version FROM events WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
    found.set(r.id, r);
  }
  console.table(
    ids.map((id) => {
      const r = found.get(id);
      return r
        ? { id, expected: ANCHORS[id], present: 'yes', title: r.title, start: r.date_start, end: r.date_end, scope: r.scope, category: r.category, notability: r.notability, coords: r.lat == null ? 'NULL' : 'ok', reach_km: r.reach_km }
        : { id, expected: ANCHORS[id], present: 'NO', title: '-', start: '-', end: null, scope: '-', category: '-', notability: null, coords: '-', reach_km: null };
    }),
  );
  console.log('\nTitle search for era-defining rows (any source):');
  console.table(all(`SELECT id, title, date_start, scope, category, notability, ingest_version FROM events WHERE title LIKE 'World War%' OR title LIKE '%pandemic%' OR title LIKE '%influenza%' OR title LIKE '%Great Depression%' OR title LIKE '%Cold War%' OR title LIKE '%famine%' OR title LIKE '%plague%' OR title LIKE '%epidemic%' OR title LIKE '%financial crisis%' ORDER BY notability DESC LIMIT 40`));
}

// ===================== H. fixture probe =====================
if (want('H')) {
  const lat = parseFloat(process.env.DIAG_LAT ?? '39.1031');
  const lng = parseFloat(process.env.DIAG_LNG ?? '-84.5120');
  const from = parseInt(process.env.DIAG_FROM ?? '1925', 10);
  const to = parseInt(process.env.DIAG_TO ?? '1950', 10);
  section('H', `Fixture probe: candidates per year within reach of ${lat}, ${lng} (${from}-${to})`);
  if (!has('reach_km') || !has('significance')) {
    console.log('Needs reach_km + significance columns: run `npm run score` first.');
  } else {
    // Mirrors DEFAULT_CONFIG in core.ts (scopeFloor + significanceFloor for the person tier).
    const FLOOR: Record<string, number> = { local: 0.05, regional: 0.15, national: 0.15, global: 0.2, person: 0.15 };
    const rows = all(`SELECT ${YEAR} AS y, scope, category, lat, lng, reach_km, significance FROM events WHERE lat IS NOT NULL AND lng IS NOT NULL AND reach_km IS NOT NULL AND significance IS NOT NULL AND ${YEAR} BETWEEN ? AND ?`, from, to);
    const perYear = new Map<number, Row>();
    for (let y = from; y <= to; y++) perYear.set(y, { year: y, local: 0, regional: 0, national: 0, global: 0, person: 0, total: 0 });
    for (const r of rows) {
      if (haversineKm(lat, lng, r.lat, r.lng) > r.reach_km) continue;
      const tier = r.category === 'birth' || r.category === 'death' ? 'person' : SCOPES.includes(r.scope) ? (r.scope as string) : 'local';
      if (r.significance < FLOOR[tier]) continue;
      const row = perYear.get(r.y);
      if (!row) continue;
      row[tier] += 1;
      row.total += 1;
    }
    const table = [...perYear.values()];
    console.table(table);
    const empty = table.filter((r) => r.total === 0).map((r) => r.year as number);
    console.log(`Years with ZERO candidates above the floors: ${empty.length ? empty.join(', ') : 'none'}`);
    const thin = table.filter((r) => r.local + r.regional === 0).map((r) => r.year as number);
    console.log(`Years with no local/regional candidate: ${thin.length ? thin.join(', ') : 'none'}`);
    console.log('Read: a hole here is a DATA gap (nothing to pick); a hole in the fixture output but not here is a SELECTION gap (temporal spread).');
  }
}

// ===================== I. title hygiene =====================
if (want('I')) {
  section('I', 'Title hygiene');
  const words = ['tower', 'building', 'skyscraper', 'bridge', 'ship', 'submarine', 'stadium', 'aircraft', 'locomotive', 'vehicle', 'dam', 'station', 'observatory', 'lighthouse', 'monument', 'church', 'cathedral'];
  const like = words.map((w) => `lower(COALESCE(blurb, '')) LIKE '%${w}%'`).join(' OR ');
  const structN = one(`SELECT COUNT(*) AS c FROM events WHERE category = 'discovery' AND (${like})`).c as number;
  const discN = one(`SELECT COUNT(*) AS c FROM events WHERE category = 'discovery'`).c as number;
  console.log(`'discovery' rows whose blurb names a structure/vehicle ("Discovery of CN Tower"): ${num(structN)} of ${num(discN)}`);
  console.table(all(`SELECT id, title, ${col('display_title')}, substr(blurb, 1, 70) AS blurb, notability FROM events WHERE category = 'discovery' AND (${like}) ORDER BY notability DESC LIMIT 20`));

  const kindClause = has('founding_kind') ? `AND founding_kind = 'settlement'` : '';
  console.log(`\nSettlement names shared by more than one founding row ("Founding of Toronto" -- which one?):`);
  console.table(all(`SELECT title, COUNT(*) AS n, MAX(notability) AS top_notability, GROUP_CONCAT(substr(blurb, 1, 45), ' | ') AS blurbs FROM events WHERE category = 'founding' ${kindClause} GROUP BY title HAVING COUNT(*) > 1 ORDER BY top_notability DESC LIMIT 20`));

  console.log('\nMost notable person rows (bare names today; the sprint wants "<name> born" / "<name> died"):');
  console.table(all(`SELECT id, title, ${col('display_title')}, date_start, category, notability FROM events WHERE ${IS_PERSON} ORDER BY notability DESC LIMIT 10`));

  if (has('display_title')) {
    const seedNoDisplay = one(`SELECT COUNT(*) AS c FROM events WHERE ${IS_SEED} AND display_title IS NULL`).c as number;
    const seedAll = one(`SELECT COUNT(*) AS c FROM events WHERE ${IS_SEED}`).c as number;
    console.log(`\nSeed rows without a display_title: ${num(seedNoDisplay)} of ${num(seedAll)} (display-titles.ts skips seed rows by design)`);
  }
}

db.close();
console.log('\nDone. Paste this output back into the sprint thread.');
