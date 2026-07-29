import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

// ===================== Wikipedia timeline scraper (dump-v0.7) =====================
// Harvests geopolitical changes + century event lists from Wikipedia, resolving
// place coordinates via wikilink → Wikidata → P625. Complements the Wikidata dump
// with high-notability treaties, annexations, independence declarations, and capital
// moves that exist only as prose timeline entries, not standalone Wikidata items.
//
//   npm run ingest:timeline -- --dry    preview yield without writing
//   npm run ingest:timeline             apply
//   npm run score                       compute significance + reach
//
// Idempotent: each row gets a deterministic id from (source page, date, title hash),
// so re-running refreshes mutable fields. All rows tagged ingest_version='dump-v0.7'.

const __dirname = dirname(fileURLToPath(import.meta.url));
const INGEST_VERSION = 'dump-v0.7';
const DRY_RUN = process.argv.includes('--dry');

// ===================== Wikipedia API client =====================

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WD_API = 'https://www.wikidata.org/w/api.php';

async function fetchJson(url: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, format: 'json' }).toString();
  const res = await fetch(`${url}?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

interface PageWikitext { title: string; wikitext: string; }

async function fetchWikitext(titles: string[]): Promise<PageWikitext[]> {
  const batch = titles.slice(0, 50); // API limit
  const data = await fetchJson(WIKI_API, {
    action: 'query',
    titles: batch.join('|'),
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
  });
  const pages: PageWikitext[] = [];
  for (const p of Object.values(data.query?.pages ?? {})) {
    const page = p as any;
    if (page.missing) continue;
    const content = page.revisions?.[0]?.slots?.main?.['*'];
    if (content) pages.push({ title: page.title, wikitext: content });
  }
  return pages;
}

// Resolve Wikipedia titles → Wikidata QIDs in batches of 50.
async function resolveQIDs(titles: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const data = await fetchJson(WIKI_API, {
      action: 'query',
      titles: batch.join('|'),
      prop: 'pageprops',
      ppprop: 'wikibase_item',
    });
    for (const p of Object.values(data.query?.pages ?? {})) {
      const page = p as any;
      const qid = page.pageprops?.wikibase_item;
      if (qid) map.set(page.title, qid);
    }
  }
  return map;
}

interface WdEntity {
  qid: string;
  sitelinks: number;
  coord: { lat: number; lng: number } | null;
  instanceOf: string[];
  country: string | null;
}

// Fetch Wikidata entities (P625, P31, P17, sitelink count) in batches of 50.
async function fetchWdEntities(qids: string[]): Promise<Map<string, WdEntity>> {
  const map = new Map<string, WdEntity>();
  for (let i = 0; i < qids.length; i += 50) {
    const batch = qids.slice(i, i + 50);
    const data = await fetchJson(WD_API, {
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'claims|sitelinks',
    });
    for (const [qid, e] of Object.entries(data.entities ?? {})) {
      const entity = e as any;
      const sitelinks = entity.sitelinks ? Object.keys(entity.sitelinks).length : 0;
      const p625 = entity.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
      const coord = p625 && typeof p625.latitude === 'number' ? { lat: p625.latitude, lng: p625.longitude } : null;
      const instanceOf = (entity.claims?.P31 ?? []).map((c: any) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
      const country = entity.claims?.P17?.[0]?.mainsnak?.datavalue?.value?.id ?? null;
      map.set(qid, { qid, sitelinks, coord, instanceOf, country });
    }
  }
  return map;
}

// ===================== Wikilink parsing =====================

// Extract all [[wikilinks]] from wikitext, stripping display text (e.g. [[A|B]] → A).
function extractWikilinks(text: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = m[1].trim();
    if (title && !title.startsWith('File:') && !title.startsWith('Image:') && !title.startsWith('Category:')) {
      links.push(title);
    }
  }
  return links;
}

// ===================== Place type detection =====================

const PLACE_TYPES = new Set([
  'Q6256',    // country
  'Q3624078', // sovereign state
  'Q515',     // city
  'Q486972',  // human settlement
  'Q1549591', // big city
  'Q532',     // village
  'Q15284',   // municipality
  'Q10864048',// first-level admin
  'Q82794',   // region
  'Q82794',   // geographic region
  'Q618123',  // geographical feature
  'Q82794',   // region
]);

function isPlace(entity: WdEntity): boolean {
  return entity.instanceOf.some((t) => PLACE_TYPES.has(t));
}

// ===================== Verb-based place picker =====================

const ACTION_VERBS = [
  'conquers', 'conquer', 'conquered', 'annexes', 'annex', 'annexed', 'annexation',
  'cedes', 'cede', 'ceded', 'cession', 'gains', 'gain', 'gained', 'secedes', 'secede',
  'declares', 'declare', 'declared', 'independence', 'establishes', 'establish',
  'supersedes', 'supersede', 'admitted', 'capitulates', 'dissolves', 'moves',
];

function pickPlace(sentence: string, wdEntities: Map<string, WdEntity>, titleToQid: Map<string, string>): WdEntity | null {
  const links = extractWikilinks(sentence);
  if (links.length === 0) return null;

  // Resolve all links to Wikidata entities.
  const placeEntities: Array<{ entity: WdEntity; pos: number; title: string }> = [];
  for (let i = 0; i < links.length; i++) {
    const qid = titleToQid.get(links[i]);
    if (!qid) continue;
    const ent = wdEntities.get(qid);
    if (!ent || !isPlace(ent)) continue;
    const pos = sentence.indexOf(`[[${links[i]}`);
    placeEntities.push({ entity: ent, pos, title: links[i] });
  }
  if (placeEntities.length === 0) return null;

  // Find the first action verb.
  const lower = sentence.toLowerCase();
  let verbPos = -1;
  for (const v of ACTION_VERBS) {
    const p = lower.indexOf(v);
    if (p !== -1 && (verbPos === -1 || p < verbPos)) verbPos = p;
  }

  // If a verb is found, prefer the place link closest AFTER it (the object).
  if (verbPos !== -1) {
    const after = placeEntities.filter((pe) => pe.pos > verbPos);
    if (after.length > 0) return after[0].entity;
  }

  // Fallback: pick the last place link with >10 sitelinks (the most notable).
  const notable = placeEntities.filter((pe) => pe.entity.sitelinks > 10);
  if (notable.length > 0) return notable[notable.length - 1].entity;

  // Last resort: just take the last place link.
  return placeEntities[placeEntities.length - 1].entity;
}

// ===================== Date parsing =====================

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

interface ParsedDate { date_start: string; precision: 'day' | 'month' | 'year'; year: number; }

function parseDate(year: number, dateStr: string): ParsedDate | null {
  if (!dateStr || !year) return null;
  const s = dateStr.trim().toLowerCase();

  // "14 February", "February 14"
  const dayMonth = s.match(/^(\d{1,2})\s+(\w+)$/) ?? s.match(/^(\w+)\s+(\d{1,2})$/);
  if (dayMonth) {
    const month = MONTHS[dayMonth[1]] ?? MONTHS[dayMonth[2]];
    const day = parseInt(dayMonth[1], 10) || parseInt(dayMonth[2], 10);
    if (month && day) return { date_start: `${pad(year, 4)}-${pad(month)}-${pad(day)}`, precision: 'day', year };
  }

  // "February"
  const monthOnly = MONTHS[s];
  if (monthOnly) return { date_start: `${pad(year, 4)}-${pad(monthOnly)}-01`, precision: 'month', year };

  // Year only
  return { date_start: `${pad(year, 4)}-01-01`, precision: 'year', year };
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

// ===================== Table parser (geopolitical timelines) =====================

interface TableRow { year: number; date: string; event: string; }

function parseGeopoliticalTable(wikitext: string): TableRow[] {
  const rows: TableRow[] = [];
  const lines = wikitext.split('\n');
  let inTable = false;
  let currentYear = 0;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('{|')) { inTable = true; continue; }
    if (t.startsWith('|}')) { inTable = false; currentYear = 0; continue; }
    if (!inTable || !t.startsWith('|')) continue;

    // Parse: | year | date | event | or | | date | event | (blank year = same as above)
    const cells = t.split('|').slice(1).map((c) => c.trim());
    if (cells.length < 3) continue;

    const yearStr = cells[0];
    const dateStr = cells[1];
    const event = cells[2];

    if (yearStr && /^\d{3,4}$/.test(yearStr)) currentYear = parseInt(yearStr, 10);
    if (!currentYear || !event) continue;

    rows.push({ year: currentYear, date: dateStr, event });
  }

  return rows;
}

// ===================== Prose bullet parser (century pages) =====================

function parseCenturyBullets(wikitext: string): TableRow[] {
  const rows: TableRow[] = [];
  const lines = wikitext.split('\n');

  for (const line of lines) {
    const t = line.trim();
    // Match bullets like "- 1805: The Battle of Trafalgar..."
    const m = t.match(/^[-*]\s*(\d{4})(?:[–—](\d{4}))?\s*:\s*(.+)$/);
    if (!m) continue;
    const year = parseInt(m[1], 10);
    const event = m[3];
    if (year && event) rows.push({ year, date: '', event });
  }

  return rows;
}

// ===================== Category classification =====================

function classifyCategory(event: string): string {
  const lower = event.toLowerCase();
  if (/\b(treaty|convention|accord|pact)\b/.test(lower)) return 'treaty';
  if (/\b(war|battle|siege|invasion|conflict)\b/.test(lower)) return 'conflict';
  if (/\b(independence|declares|secedes|established|founded|gains)\b/.test(lower)) return 'founding';
  if (/\b(election|elected)\b/.test(lower)) return 'election';
  return 'event';
}

// ===================== Main ingestion =====================

const GEOPOLITICAL_PAGES = [
  'Timeline of geopolitical changes (before 1500)',
  'Timeline of geopolitical changes (1500–1899)',
  'Timeline of geopolitical changes (1900–1999)',
  'Timeline of geopolitical changes (2000–present)',
];

const CENTURY_PAGES = [
  '15th century',
  '16th century',
  '17th century',
  '18th century',
  '19th century',
  '20th century',
];

const ALL_PAGES = [...GEOPOLITICAL_PAGES, ...CENTURY_PAGES];

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).padStart(6, '0');
}

(async () => {
  console.log('Fetching wikitext from 10 Wikipedia pages...');
  const pages = await fetchWikitext(ALL_PAGES);
  console.log(`Loaded ${pages.length} pages.\n`);

  const allRows: Array<TableRow & { source: string }> = [];
  for (const page of pages) {
    const isGeo = GEOPOLITICAL_PAGES.includes(page.title);
    const parsed = isGeo ? parseGeopoliticalTable(page.wikitext) : parseCenturyBullets(page.wikitext);
    for (const r of parsed) allRows.push({ ...r, source: page.title });
    console.log(`  ${page.title}: ${parsed.length} rows`);
  }
  console.log(`\nTotal parsed: ${allRows.length} rows\n`);

  // Extract all unique wikilinks.
  console.log('Extracting wikilinks...');
  const allLinks = new Set<string>();
  for (const r of allRows) {
    for (const link of extractWikilinks(r.event)) allLinks.add(link);
  }
  console.log(`Found ${allLinks.size} unique wikilinks.\n`);

  // Resolve Wikipedia titles → Wikidata QIDs.
  console.log('Resolving QIDs...');
  const titleToQid = await resolveQIDs([...allLinks]);
  console.log(`Resolved ${titleToQid.size} titles to QIDs.\n`);

  // Fetch Wikidata entities (coordinates, types, sitelinks).
  console.log('Fetching Wikidata entities...');
  const wdEntities = await fetchWdEntities([...titleToQid.values()]);
  console.log(`Loaded ${wdEntities.size} Wikidata entities.\n`);

  // Also fetch country entities for centroid fallback.
  const countryQids = new Set<string>();
  for (const ent of wdEntities.values()) {
    if (ent.country) countryQids.add(ent.country);
  }
  console.log(`Fetching ${countryQids.size} country centroids...`);
  const countryEntities = await fetchWdEntities([...countryQids]);
  console.log(`Loaded ${countryEntities.size} country coordinates.\n`);

  // Process each row.
  console.log('Processing rows...');
  const candidates: Array<{
    id: string; title: string; blurb: string; date_start: string; date_precision: string;
    lat: number; lng: number; category: string; notability: number; source_url: string;
    source_ids: string; ingest_version: string;
  }> = [];

  let dropped = 0;
  for (const r of allRows) {
    const date = parseDate(r.year, r.date);
    if (!date) { dropped++; continue; }

    const place = pickPlace(r.event, wdEntities, titleToQid);
    let coord = place?.coord ?? null;

    // Country-centroid fallback.
    if (!coord && place?.country) {
      const countryEnt = countryEntities.get(place.country);
      if (countryEnt?.coord) coord = countryEnt.coord;
    }

    if (!coord) { dropped++; continue; }

    // Synthesize a short title from the place name.
    const placeTitle = place ? [...titleToQid.entries()].find(([, qid]) => qid === place.qid)?.[0] ?? 'Event' : 'Event';
    const title = placeTitle.length > 60 ? placeTitle.slice(0, 60) : placeTitle;
    const blurb = r.event.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').slice(0, 280);
    const category = classifyCategory(r.event);
    const notability = place ? Math.round(Math.min(1, place.sitelinks / 100) * 1000) / 1000 : 0.5;

    const id = `timeline:${hashStr(r.source)}:${date.date_start}:${hashStr(title)}`;
    const source_url = `https://en.wikipedia.org/wiki/${encodeURIComponent(r.source.split(' ').join('_'))}`;

    candidates.push({
      id, title, blurb, date_start: date.date_start, date_precision: date.precision,
      lat: coord.lat, lng: coord.lng, category, notability,
      source_url, source_ids: JSON.stringify({ wikipedia: r.source, place: place?.qid ?? null }),
      ingest_version: INGEST_VERSION,
    });
  }

  console.log(`\nKept: ${candidates.length} rows`);
  console.log(`Dropped (no coordinates): ${dropped} rows\n`);

  if (DRY_RUN) {
    console.log('DRY RUN. Showing first 20 rows:\n');
    for (const c of candidates.slice(0, 20)) {
      console.log(`  ${c.date_start} · ${c.title} · ${c.category} · ${c.notability} · ${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}`);
      console.log(`    ${c.blurb.slice(0, 120)}...\n`);
    }
    console.log('Re-run without --dry to apply.');
    process.exit(0);
  }

  // Write to DB.
  const db = new Database('events.sqlite');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO events
      (id, title, blurb, date_start, date_precision, lat, lng, category, notability, source_url, source_ids, ingest_version)
    VALUES
      (@id, @title, @blurb, @date_start, @date_precision, @lat, @lng, @category, @notability, @source_url, @source_ids, @ingest_version)
  `);

  db.exec('BEGIN');
  for (const c of candidates) upsert.run(c);
  db.exec('COMMIT');

  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild');`);
  db.prepare(`INSERT INTO meta(key, value) VALUES('dataset_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(INGEST_VERSION);

  const total = (db.prepare('SELECT COUNT(*) AS c FROM events').get() as any).c;
  console.log(`Inserted ${candidates.length} timeline events.`);
  console.log(`Total events in DB: ${total.toLocaleString()}\n`);
  console.log('Next: npm run score');
  db.close();
})().catch((err) => { console.error(err); process.exit(1); });
