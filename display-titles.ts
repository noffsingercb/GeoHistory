import Database from 'better-sqlite3';

// ===================== Display titles (post-ingest build pass) =====================
// Wikidata labels the THING. Our rows represent an EVENT about that thing. So a
// row for Arizona's admission to the Union is titled 'Arizona', and a row for
// David Packard's birth is titled 'David Packard' -- correct labels, useless as
// timeline entries, because the reader cannot tell what happened.
//
// The verb is not recoverable from the label, and it does not need to be. For a
// few categories the CATEGORY IS THE VERB, so a display title can be derived from
// structured columns (category, founding_kind, category_root, place_id) plus blurb
// evidence -- never by parsing the title itself.
//
// Rules (v0.6):
//
//   birth                          -> 'Birth of Arthur C. Clarke'
//   death                          -> 'Death of Arthur C. Clarke'
//   founding + settlement          -> 'Founding of Granby'
//   founding + city                -> 'Founding of Chicago'
//   founding + subnational         -> 'Arizona Statehood'      (blurb confirms a US state)
//   founding + subnational         -> 'Founding of Ontario'    (any other subnational)
//   founding + country             -> 'Founding of Belgium'
//   founding + NULL                -> 'Founding of X'
//   discovery, root Q11019 machine -> 'Invention of the Telephone'  (a machine is invented, not found)
//   discovery, structure blurb     -> 'Construction of Brooklyn Bridge'
//   discovery, otherwise           -> 'Discovery of Radium'
//
// Duplicate founding names are disambiguated from the places table harvested by
// dump-v0.6: two 'Springfield' foundings become 'Founding of Springfield, Illinois'
// and 'Founding of Springfield, Massachusetts' (the containing admin1, walked up
// from place_id; the country when there is no admin1).
//
// NOT handled, on purpose:
//   - treaty / conflict / event / milestone / election / disaster titles are
//     already well-formed ('Treaty of Versailles', 'Battle of the Somme').
//     Prefixing them yields 'Signing of Treaty of Versailles'.
//   - seed rows (ingest_version LIKE 'seed-%') and universal rows are
//     hand-authored (seed.ts writes their display_title); never touched.
//
// display_title is NULLABLE and every consumer falls back to title, so a NULL
// simply means "no better phrasing available". The raw title is never modified:
// events_fts indexes it, and search has to keep matching what users type.
//
//   npm run titles -- --dry       preview counts + samples
//   npm run titles                apply
//   npm run titles -- --reset     clear every display_title on dump rows
//   npm run titles -- --limit=500 cap rows processed (smoke test)

const args = process.argv.slice(2);
const hasFlag = (n: string) => args.includes(`--${n}`);
const flagValue = (n: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};

const dry = hasFlag('dry');
const reset = hasFlag('reset');
const limit = Math.max(0, parseInt(flagValue('limit') ?? '0', 10) || 0);
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';

/**
 * Skip rows whose title already states the event. The audit found zero such rows
 * in founding or discovery, so this is belt-and-braces for future ingests rather
 * than a live concern -- but a second pass over a re-ingested DB must never
 * produce 'Founding of Founding of X'. Not applied to person names.
 */
const ALREADY_PHRASED =
  /\b(found|founded|founding|foundation|establish|established|establishment|incorporated|incorporation|charter|chartered|statehood|admission|admitted|creation|created|discover|discovered|discovery|invention|invented|construction|constructed)\b/i;

/**
 * Statehood phrasing is used ONLY where the blurb affirmatively identifies a US
 * state. 'Founding of the State of Arizona' would be subtly wrong -- Arizona was
 * founded as a territory in 1863 and admitted to the Union in 1912, and this row
 * is the 1912 event. Provinces, territories, and other subnational entities fall
 * back to neutral 'Founding of' phrasing rather than being guessed at.
 */
const US_STATE_BLURB = /(state of the united states|u\.?s\.?\s+state|state in the united states|u\.?s\.?\s+federated state)/i;

// Things in the discovery category that were built rather than found or invented.
const STRUCTURE_BLURB = /\b(building|skyscraper|bridge|tower|dam|canal|tunnel|railway|railroad|road|highway|ship|liner|steamship|cathedral|church|temple|mosque|palace|castle|fort|fortress|lighthouse|stadium|arena|monument|memorial|aqueduct|viaduct|pier|harbou?r|airport|station|observatory|telescope)\b/i;
const INVENTION_ROOT = 'Q11019'; // machine

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---------- Column bootstrap ----------

const columns = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
const has = (name: string) => columns.some((c) => c.name === name);
if (!has('display_title')) {
  if (dry) {
    console.log('events.display_title does not exist yet; --dry will report what would be written.');
  } else {
    db.exec(`ALTER TABLE events ADD COLUMN display_title TEXT`);
    console.log('Added column events.display_title.');
  }
}
const columnExists = (db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>)
  .some((c) => c.name === 'display_title');
// v0.5 files have no category_root / place_id; the rules degrade to blurb evidence.
const v06 = has('category_root') && has('place_id');
const hasPlaces = (db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'places'`).get() as any).c > 0;

if (reset) {
  if (!columnExists) {
    console.log('Nothing to reset: events.display_title does not exist.');
    db.close();
    process.exit(0);
  }
  const info = db.prepare(`UPDATE events SET display_title = NULL WHERE display_title IS NOT NULL AND ingest_version NOT LIKE 'seed-%' AND scope IS NOT 'universal'`).run();
  console.log(`Cleared display_title on ${info.changes.toLocaleString()} rows (seed / universal rows kept).`);
  db.close();
  process.exit(0);
}

// ---------- Rule ----------

interface Row {
  id: string;
  title: string;
  blurb: string | null;
  category: string | null;
  founding_kind: string | null;
  category_root: string | null;
  place_id: string | null;
}

type RuleName =
  | 'settlement' | 'city' | 'statehood' | 'subnational' | 'country' | 'founding-unclassified'
  | 'discovery' | 'invention' | 'construction' | 'birth' | 'death';

function displayTitleFor(row: Row): { title: string; rule: RuleName } | null {
  const name = row.title.trim();
  if (!name) return null;

  if (row.category === 'birth') return { title: `Birth of ${name}`, rule: 'birth' };
  if (row.category === 'death') return { title: `Death of ${name}`, rule: 'death' };

  if (ALREADY_PHRASED.test(name)) return null;

  if (row.category === 'discovery') {
    if (row.category_root === INVENTION_ROOT) return { title: `Invention of ${withArticle(name)}`, rule: 'invention' };
    if (STRUCTURE_BLURB.test(row.blurb ?? '')) return { title: `Construction of ${name}`, rule: 'construction' };
    return { title: `Discovery of ${name}`, rule: 'discovery' };
  }

  if (row.category === 'founding') {
    switch (row.founding_kind) {
      case 'settlement':
        return { title: `Founding of ${name}`, rule: 'settlement' };
      case 'city':
        return { title: `Founding of ${name}`, rule: 'city' };
      case 'subnational':
        return US_STATE_BLURB.test(row.blurb ?? '')
          ? { title: `${name} Statehood`, rule: 'statehood' }
          : { title: `Founding of ${name}`, rule: 'subnational' };
      case 'country':
        return { title: `Founding of ${name}`, rule: 'country' };
      default:
        return { title: `Founding of ${name}`, rule: 'founding-unclassified' };
    }
  }

  return null;
}

// 'Invention of the Telephone' reads better than 'Invention of Telephone', but
// 'Invention of the Linux' does not. Only lowercase common-noun labels get one.
function withArticle(name: string): string {
  if (/^(the|a|an)\s/i.test(name)) return name;
  if (/^[a-z]/.test(name) && !/\d/.test(name)) return `the ${name}`;
  return name;
}

// ---------- Disambiguation via places (v0.6) ----------

interface PlaceRow { id: string; name: string; level: string; parent_id: string | null; }
const getPlace = hasPlaces ? db.prepare(`SELECT id, name, level, parent_id FROM places WHERE id = ?`) : null;
const placeCache = new Map<string, PlaceRow | null>();
function placeOf(id: string | null): PlaceRow | null {
  if (!id || !getPlace) return null;
  if (!placeCache.has(id)) placeCache.set(id, (getPlace.get(id) as PlaceRow | undefined) ?? null);
  return placeCache.get(id) ?? null;
}
// The containing first-level division (state / province), else the country.
function qualifierFor(placeId: string | null): string | null {
  let p = placeOf(placeId);
  for (let hops = 0; p && hops < 4; hops++) {
    if (p.level === 'admin1' || p.level === 'country') return p.name;
    p = placeOf(p.parent_id);
  }
  return null;
}

// ---------- Pass ----------

const rows = db.prepare(`
  SELECT id, title, blurb, category, founding_kind,
         ${v06 ? 'category_root, place_id' : 'NULL AS category_root, NULL AS place_id'}
  FROM events
  WHERE category IN ('founding', 'discovery', 'birth', 'death')
    AND ingest_version NOT LIKE 'seed-%'
    AND scope IS NOT 'universal'
  ORDER BY id
  ${limit > 0 ? `LIMIT ${limit}` : ''}
`).all() as Row[];

// Founding titles that recur (Springfield x 30). Only these get a qualifier.
const duplicateFoundingTitles = new Set(
  (db.prepare(`SELECT title FROM events WHERE category = 'founding' GROUP BY title HAVING COUNT(*) > 1`).all() as Array<{ title: string }>).map((r) => r.title),
);

const counts: Record<string, number> = {};
const samples: Array<{ rule: string; before: string; after: string }> = [];
const updates: Array<{ id: string; display_title: string }> = [];
let skipped = 0;
let qualified = 0;
let unqualifiable = 0;

for (const row of rows) {
  const result = displayTitleFor(row);
  if (!result) { skipped++; continue; }
  let title = result.title;
  let rule: string = result.rule;
  if (row.category === 'founding' && duplicateFoundingTitles.has(row.title)) {
    const q = qualifierFor(row.place_id);
    if (q && q !== row.title) { title = `${title}, ${q}`; qualified++; rule = `${rule}+place`; }
    else unqualifiable++;
  }
  counts[rule] = (counts[rule] ?? 0) + 1;
  updates.push({ id: row.id, display_title: title });
  if (samples.filter((x) => x.rule === rule).length < 3) samples.push({ rule, before: row.title, after: title });
}

console.log(`\nExamined ${rows.length.toLocaleString()} founding/discovery/birth/death rows (seed + universal rows excluded).\n`);
console.log('  RULE                         ROWS');
for (const [rule, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule.padEnd(27)}  ${String(n).padStart(6)}`);
}
console.log(`  ${'(skipped, already phrased)'.padEnd(27)}  ${String(skipped).padStart(6)}`);
console.log(`\n  duplicate founding names qualified with a state/country: ${qualified.toLocaleString()} (${unqualifiable.toLocaleString()} had no resolvable place)`);
console.log(`  TOTAL to write               ${String(updates.length).padStart(6)}`);

console.log('\nSamples:');
for (const s of samples) {
  console.log(`  [${s.rule}] ${s.before}  ->  ${s.after}`);
}

if (dry) {
  console.log('\nDRY RUN. Nothing written. Re-run without --dry to apply.');
  db.close();
  process.exit(0);
}

const upd = db.prepare(`UPDATE events SET display_title = @display_title WHERE id = @id`);
let written = 0;
const run = db.transaction((batch: typeof updates) => {
  for (const u of batch) written += upd.run(u).changes;
});
run(updates);

db.prepare(`INSERT INTO meta(key, value) VALUES('last_display_titles', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  .run(`${written} rows at ${new Date().toISOString()}`);

console.log(`\nWrote display_title on ${written.toLocaleString()} rows.`);
console.log('events_fts is untouched: search still matches the raw Wikidata labels, which is intended.');
db.close();
