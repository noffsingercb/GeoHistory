PRAGMA foreign_keys = ON;

-- Populated by ingest-dump.ts pass 2 (dump-v0.6) for every country / historical country
-- ('country'), first-level division such as a US state or a province ('admin1') and
-- second-level division such as a county or district ('county'). Localities are NOT
-- harvested: a settlement's founding lives in events, and its containing county /
-- state is what display-titles.ts needs to disambiguate 'Founding of Toronto, Ohio'.
-- expand-participants.ts reads the 'country' rows for their names and centroids.
CREATE TABLE IF NOT EXISTS places (
  id        TEXT PRIMARY KEY,              -- Wikidata QID or GeoNames ID (reference to source)
  name      TEXT NOT NULL,
  level     TEXT CHECK (level IN ('locality','county','admin1','country')),
  parent_id TEXT REFERENCES places(id),    -- containment chain (self-referential): P131 located-in, else P17 country
  lat       REAL,
  lng       REAL,
  aliases   TEXT                           -- JSON array of alternate/historical names
);

-- schema v0.6 (see migrate-v06.ts for upgrading a v0.5 file in place):
--   scope gains 'universal', founding_kind gains 'institution' and 'city', and seven
--   columns are appended: coord_source, category_root, wikidata_types, sitelinks,
--   country_id, participants, deaths. New columns are appended at the END on purpose
--   so positional readers of older files keep working.
CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,          -- Wikidata QID (+ optional #birth / #death / #founding suffix); seed:<slug> / universal:<slug> for hand-curated rows
  title          TEXT NOT NULL,             -- raw source label; indexed by events_fts, never rewritten
  display_title  TEXT,                      -- event-phrased title derived from category/founding_kind (display-titles.ts); NULL means fall back to title
  blurb          TEXT,                      -- short description (<= 280 chars)
  date_start     TEXT NOT NULL,             -- ISO 8601, may be partial (1871, 1871-10, 1871-10-08)
  date_end       TEXT,                      -- ISO 8601 end of a ranged event (Wikidata P582); NULL = point event. core.ts matches a segment against [date_start, date_end], so a war overlaps every life segment it ran through
  date_precision TEXT CHECK (date_precision IN ('day','month','year','decade','century')),
  lat            REAL,
  lng            REAL,
  place_id       TEXT REFERENCES places(id),
  scope          TEXT CHECK (scope IN ('local','regional','national','global','universal')),  -- geographic reach class; 'universal' = drawn for every life that overlaps the dates, with no distance test (core.ts universalQuota)
  category       TEXT,                      -- event | conflict | disaster | election | treaty | founding | discovery | birth | death | milestone
  founding_kind  TEXT CHECK (founding_kind IN ('settlement','city','institution','subnational','country')),  -- founding sub-type (rescope-foundings.ts); overrides the scope ladder. 'city' = a Q515/Q1549591 city (regional news when founded); 'settlement' = town/village (local)
  notability     REAL,                      -- absolute fame proxy: normalized Wikidata sitelinks (0..1)
  significance   REAL,                      -- era-normalized importance (0..1); drives the floor + ranking
  reach_km       REAL,                      -- materialized relevance radius (derived from scope + significance)
  reach_min_lat  REAL,                      -- reach bounding box (portable spatial prefilter for the engine)
  reach_max_lat  REAL,
  reach_min_lng  REAL,
  reach_max_lng  REAL,
  source_url     TEXT,
  source_ids     TEXT,                      -- JSON provenance: {"wikidata":"Q..."}
  ingest_version TEXT NOT NULL,
  coord_source   TEXT,                      -- which claim placed the row. P625 = the event's own point; P19/P20 = birth/death place; P276 location, P17 country, P495 country of origin = fallback centroids. A fallback point is fuzzy: score.ts must never call such a row local or regional. NULL = seed row
  category_root  TEXT,                      -- the root type whose P279* closure classified the row (Q11019 machine = an invention, not a discovery; Q12184 pandemic; Q5 human)
  wikidata_types TEXT,                      -- JSON array of the row's P31 QIDs (first 12) so rescope-foundings.ts / display-titles.ts can stop guessing kind and verb from blurb prose
  sitelinks      INTEGER,                   -- raw Wikidata sitelink count. notability = min(1, sitelinks/100) saturates at 100; this does not, so score.ts can re-normalize per era without a re-ingest
  country_id     TEXT,                      -- P17 (country) QID of the event, when Wikidata states one. Joins places.id when that country was harvested into places
  participants   TEXT,                      -- JSON array of participant QIDs: P710 for conflicts / events / disasters, P1891 signatories for treaties. expand-participants.ts turns the country entries into national-tier rows at each country's centroid, so an overseas war a country fought in still reaches lives in that country
  deaths         INTEGER                    -- P1120 number of deaths (first stated amount), NULL when unstated. Kept raw for scoring experiments; nothing in v0.6 reads it yet
);

-- Build provenance / reproducibility (dataset version, scorer + reach formula versions, timestamps)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Indexes the ingest, scorer, search, and timeline engine rely on
CREATE INDEX IF NOT EXISTS idx_events_lat_lng      ON events(lat, lng);
CREATE INDEX IF NOT EXISTS idx_events_date_start   ON events(date_start);
CREATE INDEX IF NOT EXISTS idx_events_place        ON events(place_id);
CREATE INDEX IF NOT EXISTS idx_events_category     ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_scope        ON events(scope);
CREATE INDEX IF NOT EXISTS idx_events_significance ON events(significance);
CREATE INDEX IF NOT EXISTS idx_events_founding_kind ON events(founding_kind);
CREATE INDEX IF NOT EXISTS idx_events_reach_box    ON events(reach_min_lat, reach_max_lat, reach_min_lng, reach_max_lng);
-- Year a row stops being current: date_end when ranged, else date_start. core.ts's segment
-- prefilter uses this exact expression so the planner can pick the index up.
CREATE INDEX IF NOT EXISTS idx_events_end_year     ON events(COALESCE(substr(date_end, 1, 4), substr(date_start, 1, 4)));
CREATE INDEX IF NOT EXISTS idx_events_country      ON events(country_id);
CREATE INDEX IF NOT EXISTS idx_places_parent       ON places(parent_id);
CREATE INDEX IF NOT EXISTS idx_places_level        ON places(level);

-- Full-text search over title + blurb (external-content FTS5; rebuilt after ingest).
-- Deliberately indexes the RAW title, not display_title: users search for the
-- name of a place or thing, not for 'Founding of ...'.
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  title, blurb, content='events', content_rowid='rowid'
);
