import Database from 'better-sqlite3';

// Read-only audit for media leakage, universal-tier duplicate candidates,
// and founding rows whose current scope may be too broad.
const DB_PATH = process.env.GEOHISTORY_DB ?? 'events.sqlite';
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const WIKIPEDIA_LINK_COLUMN = 'source_url';
const MEDIA_TYPE_QIDS = [
  'Q11424',    // film
  'Q24856',    // film series
  'Q15416',    // television program
  'Q5398426',  // television series
  'Q581714',   // animated series
  'Q63952888', // animated television series
  'Q7889',     // video game
  'Q196600',   // media franchise
  'Q1004',     // comic book
  'Q178296',   // comic strip
  'Q213369',   // webcomic
  'Q8261',     // novel
  'Q482994',   // album
  'Q7366',     // song
  'Q24634210', // podcast
];

const markdownValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
};

const printTable = (columns: string[], rows: Array<Record<string, unknown>>): void => {
  console.log(`| ${columns.join(' | ')} |`);
  console.log(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    console.log(`| ${columns.map((column) => markdownValue(row[column])).join(' | ')} |`);
  }
  if (rows.length === 0) {
    console.log(`| ${columns.map((_, index) => index === 0 ? 'No rows' : '').join(' | ')} |`);
  }
};

const normalizedDate = (alias: string): string => `
  CASE
    WHEN length(${alias}.date_start) = 4 THEN ${alias}.date_start || '-01-01'
    WHEN length(${alias}.date_start) = 7 THEN ${alias}.date_start || '-01'
    ELSE substr(${alias}.date_start, 1, 10)
  END
`;

try {
  // Query A: use P31 values whenever a non-empty valid array is present. Only
  // older rows without usable types fall back to the blurb's head phrase.
  const qidPlaceholders = MEDIA_TYPE_QIDS.map(() => '?').join(', ');
  const mediaPredicate = `
    CASE
      WHEN wikidata_types IS NOT NULL
       AND json_valid(wikidata_types)
       AND json_type(wikidata_types) = 'array'
       AND json_array_length(wikidata_types) > 0
      THEN EXISTS (
        SELECT 1
        FROM json_each(wikidata_types)
        WHERE json_each.value IN (${qidPlaceholders})
      )
      ELSE (
        head_phrase = 'film' OR head_phrase LIKE '% film' OR
        head_phrase = 'film series' OR head_phrase LIKE '% film series' OR
        head_phrase = 'television program' OR head_phrase LIKE '% television program' OR
        head_phrase = 'television series' OR head_phrase LIKE '% television series' OR
        head_phrase = 'tv series' OR head_phrase LIKE '% tv series' OR
        head_phrase = 'animated series' OR head_phrase LIKE '% animated series' OR
        head_phrase = 'animated television series' OR head_phrase LIKE '% animated television series' OR
        head_phrase = 'video game' OR head_phrase LIKE '% video game' OR
        head_phrase = 'media franchise' OR head_phrase LIKE '% media franchise' OR
        head_phrase = 'franchise' OR head_phrase LIKE '% franchise' OR
        head_phrase = 'comic book' OR head_phrase LIKE '% comic book' OR
        head_phrase = 'comic strip' OR head_phrase LIKE '% comic strip' OR
        head_phrase = 'webcomic' OR head_phrase LIKE '% webcomic' OR
        head_phrase = 'novel' OR head_phrase LIKE '% novel' OR
        head_phrase = 'album' OR head_phrase LIKE '% album' OR
        head_phrase = 'song' OR head_phrase LIKE '% song' OR
        head_phrase = 'podcast' OR head_phrase LIKE '% podcast'
      )
    END
  `;
  const mediaCte = `
    WITH normalized AS (
      SELECT *, lower(trim(
        CASE
          WHEN instr(COALESCE(blurb, ''), ',') > 0
            THEN substr(blurb, 1, instr(blurb, ',') - 1)
          ELSE COALESCE(blurb, '')
        END
      )) AS head_phrase
      FROM events
    ), media AS (
      SELECT *
      FROM normalized
      WHERE scope IN ('global', 'national')
        AND (${mediaPredicate})
    )
  `;
  const mediaSummary = db.prepare(`${mediaCte}
    SELECT COUNT(*) AS row_count,
           ROUND(AVG(significance), 3) AS avg_significance,
           ROUND(AVG(reach_km), 1) AS avg_reach_km
    FROM media
  `).get(...MEDIA_TYPE_QIDS) as Record<string, unknown>;
  const mediaRows = db.prepare(`${mediaCte}
    SELECT title, id, category, scope, wikidata_types, blurb
    FROM media
    ORDER BY significance DESC, notability DESC, title ASC
    LIMIT 30
  `).all(...MEDIA_TYPE_QIDS) as Array<Record<string, unknown>>;

  console.log('## Query A');
  console.log(`Query A found ${mediaSummary.row_count} global/national media rows (avg significance ${mediaSummary.avg_significance ?? 'n/a'}, avg reach_km ${mediaSummary.avg_reach_km ?? 'n/a'}) and used Wikipedia-link column \`${WIKIPEDIA_LINK_COLUMN}\`.`);
  printTable(['title', 'id', 'category', 'scope', 'wikidata_types', 'blurb'], mediaRows);
  console.log();

  // Query B: this intentionally emits candidates only; same/nearby dates do
  // not establish that two rows represent the same real-world event.
  const duplicateRows = db.prepare(`
    SELECT u.id AS universal_id,
           u.title AS universal_title,
           length(COALESCE(u.blurb, '')) AS universal_blurb_length,
           u.${WIKIPEDIA_LINK_COLUMN} AS universal_source_url,
           u.ingest_version AS universal_ingest_version,
           o.id AS other_id,
           o.title AS other_title,
           length(COALESCE(o.blurb, '')) AS other_blurb_length,
           o.${WIKIPEDIA_LINK_COLUMN} AS other_source_url,
           o.ingest_version AS other_ingest_version,
           u.date_start AS universal_date_start,
           o.date_start AS other_date_start
    FROM events u
    JOIN events o
      ON o.scope != 'universal'
     AND o.id != u.id
     AND abs(julianday(${normalizedDate('u')}) - julianday(${normalizedDate('o')})) <= 3
    WHERE u.scope = 'universal'
    ORDER BY u.date_start ASC, u.id ASC, o.date_start ASC, o.id ASC
  `).all() as Array<Record<string, unknown>>;

  console.log('## Query B');
  console.log(`Query B found ${duplicateRows.length} universal/non-universal candidate pairs within three days; these are unadjudicated candidates, not confirmed duplicates.`);
  printTable([
    'universal_id', 'universal_title', 'universal_blurb_length', 'universal_source_url',
    'universal_ingest_version', 'other_id', 'other_title', 'other_blurb_length',
    'other_source_url', 'other_ingest_version', 'universal_date_start', 'other_date_start',
  ], duplicateRows);
  console.log();

  const foundingGroups = db.prepare(`
    SELECT founding_kind, scope, COUNT(*) AS row_count
    FROM events
    WHERE category = 'founding'
    GROUP BY founding_kind, scope
    ORDER BY founding_kind IS NOT NULL DESC, founding_kind ASC, scope ASC
  `).all() as Array<Record<string, unknown>>;
  const cityRows = db.prepare(`
    SELECT id, title, blurb, wikidata_types, notability, significance, scope
    FROM events
    WHERE category = 'founding'
      AND founding_kind = 'city'
      AND scope != 'local'
    ORDER BY notability DESC, significance DESC, id ASC
    LIMIT 20
  `).all() as Array<Record<string, unknown>>;
  const unclassifiedRows = db.prepare(`
    SELECT id, title, blurb, wikidata_types, notability, significance, scope
    FROM events
    WHERE category = 'founding'
      AND founding_kind IS NULL
      AND scope IN ('national', 'global')
    ORDER BY notability DESC, significance DESC, id ASC
    LIMIT 20
  `).all() as Array<Record<string, unknown>>;
  const evidenceRows = db.prepare(`
    SELECT *
    FROM events
    WHERE id IN ('Q88', 'Q1810731')
       OR id LIKE 'Q88#%'
       OR id LIKE 'Q1810731#%'
    ORDER BY id ASC
  `).all() as Array<Record<string, unknown>>;
  const eventColumns = (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((column) => column.name);

  console.log('## Query C');
  console.log(`Query C found ${foundingGroups.length} founding-kind/scope groups, ${cityRows.length} non-local city rows (top 20 shown), ${unclassifiedRows.length} national/global unclassified rows (top 20 shown), and ${evidenceRows.length} rows for Q88/Q1810731.`);
  console.log('### Founding kind by scope');
  printTable(['founding_kind', 'scope', 'row_count'], foundingGroups);
  console.log('\n### City foundings above local');
  printTable(['id', 'title', 'blurb', 'wikidata_types', 'notability', 'significance', 'scope'], cityRows);
  console.log('\n### Unclassified national/global foundings');
  printTable(['id', 'title', 'blurb', 'wikidata_types', 'notability', 'significance', 'scope'], unclassifiedRows);
  console.log('\n### Q88 and Q1810731 full rows');
  printTable(eventColumns, evidenceRows);
} finally {
  db.close();
}
