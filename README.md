# GeoHistory

*An open, geo-located historical events dataset and a deterministic timeline protocol. Give it a person's places and dates; get back a sourced timeline of the history that surrounded their life.*

**Status:** v0.7 - comprehensive dataset (116,295 events, `dump-v0.6`) + curated seed layers (`milestone`, `universal`) + event-radius engine with a distance-blind universal tier and ranged-event phases + JSON API (live on Render) + prune tooling

## Overview

GeoHistory answers one question: *"What was happening in and around the places where someone lived, while they lived there?"* It has two parts:

1. **An open events dataset** - a flat, geo-located, pre-scored SQLite table of historically significant events harvested from Wikidata, supplemented by a curated seed layer for categories (like milestone inventions) that benefit from hand review.
2. **A deterministic timeline engine** - a pure function that takes a list of life events (place + date) and returns a ranked, cited timeline. No network calls or model inference at query time.

All intelligence is computed **once, at build time**, and frozen into static columns. Query time is pure lookups, so the same file drives both a server API and an in-browser applet.

The scope of this repository is deliberately narrow: **the dataset, its ingest and scoring pipeline, and the read-only API that exposes them.** Presentation lives in Circa, a separate client.

## The two axes of relevance

Every event is scored on two independent axes so the timeline is both *placed* and *interesting*:

- **Reach** (`scope` -> `reach_km`): how far the event's relevance radiates. An event matches you when your coordinate falls inside its reach circle. A county fair reaches ~40 km; a national election reaches its country; a world war reaches everywhere.
- **Significance** (`significance`, 0..1): does anyone care? Era-normalized (decade percentile) so a standout 1600s event isn't buried under modern volume. Below a floor, events are dropped; above it, significance ranks them within per-scope quotas.

There is a third scope, `universal`, that opts out of the first axis entirely: it is distance-blind and matches any segment it overlaps in time. It is drawn under its own `universalQuota` rather than through the round-robin fill, and it carries a deliberately severe floor, because significance is the only gate left on it.

## Ranged events

An event carrying a `date_end` is a candidate in **every** segment its range overlaps, and each occurrence is drawn with a `phase`: `begins` in the segment holding `date_start`, `ends` in the segment holding `date_end`, and `ongoing` where the segment sits inside the range with neither endpoint in it. A life that starts mid-war gets "World War II - ongoing" rather than nothing at all. 5,142 rows (4.4%) currently carry a `date_end`.

The phase decides the **display date**, which is not the same as `date_start`. `phase-display.ts` owns that rule in one place so it is testable without a database: `ends` resolves to `date_end` at the coarser of the two precisions, `ongoing` resolves to the segment start at year precision, and everything else keeps `date_start`. Entries carry `displayDateISO` and `displayPrecision` alongside the raw dates.

That resolved date is authoritative for **three** things in `core.ts` - the per-segment sort, the final sort, and the ~6-year bucketing in `applyTemporalSpread`. Keying any one of them on `date_start` while the others use the resolved date does not merely misorder a row, it silently deletes one: the entry is bucketed at a year it no longer displays, finds that bucket full, and is dropped with no error and no warning. `docs/engine-invariants.md` records this and the other invariants that are cheap to break and expensive to find.

## Pipeline

```
seed  ->  ingest:dump  ->  rescope:foundings  ->  prune:media  ->  prune:series
      ->  merge-universal-dupes  ->  prune:dupes  ->  score  ->  expand:participants
      ->  score  ->  titles                        ==  npm run post-ingest

then:  timeline / search / stats / serve
```

`npm run post-ingest` runs exactly that chain, in that order, and the order matters: `score` runs twice because `expand:participants` creates rows that have never been scored, and `titles` runs last because it reads the final scope and category of every surviving row. `npm run ingest` is the small live-SPARQL sample rather than a step in this chain.

1. **Harvest** - two options:
   - `ingest.ts` (`npm run ingest`): quick sample via the live Wikidata SPARQL endpoint (1900-present). Good for tests.
   - `ingest-dump.ts` (`npm run ingest:dump`): the **comprehensive build** from a local Wikidata dump - no rate limits, ~750-year window, and **true date precision**.
2. **Seed (curated rows)** - `seed.ts` (`npm run seed`) merges hand-authored rows into the same `events` table, for categories that are better hand-curated than mined (currently `milestone`, invention/discovery-firsts reviewed in Notion, and `universal`, the distance-blind tier). Source rows live in era-bucketed files under `seed/` (split to avoid single-write truncation on large pushes) and are loaded idempotently: each row's id is `seed:<slug of title>`, and `ingest_version` starts with `seed-` so seed rows are always identifiable and re-seeding after an edit just upserts.
3. **Structural passes** - `rescope-foundings.ts` re-derives founding scope from `founding_kind`; `prune-media.ts`, `prune-series.ts`, `merge-universal-dupes.ts` and `prune-seed-dupes.ts` remove film/TV/franchise rows, recurring series instances, universal rows that duplicate a global twin, and seed rows the dump already covers.
4. `score.ts` (`npm run score`) derives the two axes and materializes the relevance radius. It **preserves the authored scope** on seed rows rather than recomputing it.
5. `expand-participants.ts` emits per-participant sibling rows for multi-party events, then `score` runs again over them.
6. `display-titles.ts` (`npm run titles`) materializes `display_title` - "Birth of X", "Founding of X" - so the client never has to synthesize a label.
7. `core.ts` matches and ranks at query time using only the frozen columns.

`prune.ts` (`npm run prune <category> [floor] [apply]`) remains available outside the chain for reviewing and removing the least-notable rows within one category without re-running the ingest. A dry run (no floor, or a floor without `apply`) prints a notability histogram and shows how many rows each candidate floor would remove; passing `apply` deletes rows below the floor and rebuilds the FTS index. Useful for high-volume, uneven categories like `election`, where most harvested rows are minor local races.

### Comprehensive build (dumps)

1. Download the dump (~90-140 GB gzip):
   `https://dumps.wikimedia.org/wikidatawiki/entities/latest-all.json.gz`
2. Point the ingester at it and run (PowerShell):
   ```powershell
   $env:WIKIDATA_DUMP="D:\wikidata\latest-all.json.gz"; npm run ingest:dump
   npm run score
   npm run timeline
   ```
3. **Validate on a slice first** (stops after N lines), then start from an empty DB for the full run:
   ```powershell
   Remove-Item events.sqlite, events.sqlite-wal, events.sqlite-shm -ErrorAction SilentlyContinue
   $env:WIKIDATA_DUMP="D:\wikidata\latest-all.json.gz"; $env:INGEST_MAX_LINES=2000000; npm run ingest:dump
   ```

How it works: **Pass 1** indexes every entity's coordinates (`P625`) and subclass edges (`P279`); a **closure step** expands each category's root types into their descendants via a recursive query; **Pass 2** classifies and extracts each event, resolving a person's birthplace to coordinates via the pass-1 index, and capturing each date at its real Wikidata precision (year / month / day / decade / century).

Env knobs: `WIKIDATA_DUMP` (required), `INGEST_START_YEAR` (default 1275), `INGEST_END_YEAR` (default current year), `INGEST_MAX_LINES` (0 = all), `INGEST_PASS` (`coords` | `events` | `all`).

### Curated seed layer

Some categories are sparse or noisy straight from Wikidata (e.g. many elections, treaties, and other agreements lack their own coordinates and get dropped - see Known refinements below). For these, a small curated set can be reviewed by hand in a Notion table, exported to JSON, and merged in deterministically:

- Export curated rows to `seed/*.json` using the exact Notion column names (`Title`, `Blurb`, `Date start`, `Precision`, `Category`, `Place`, `Lat`, `Lng`, `Notability`, `Scope (intended)`, `Source URL`, `Ingest version`).
- Keep files reasonably small (tens of rows each) rather than one large file - very large single-file writes are prone to silent truncation depending on how they're pushed.
- Add each new file to the `FILES` list in `seed.ts`, then run `npm run seed` followed by `npm run score`.
- The `milestone` category (firsts in invention/discovery, e.g. the Moon Landing) is the first curated set, sourced from Wikipedia's "Timeline of historic inventions." Not every instance of a repeating milestone-adjacent category (e.g. presidential elections) is inherently notable - curation should keep only the genuinely important instances rather than every occurrence.
- `seed/universal-v0.1.json` is the second: the distance-blind `universal` tier, where a row is on the timeline because it happened at all, not because of where it happened.

### Inspecting a build

`npm run stats` prints a read-only composition report - total count, breakdown by category / date precision / scope, year span, sample year-precision events, and the `meta` provenance rows. Use it to sanity-check a build before shipping it.

`npm run diag`, `npm run diagnose` and `npm run diagnose:dates` are the deeper reports: the v0.6 baseline, a defect sweep, and a date-range audit that lists rows which look ranged but carry no `date_end`. All three are read-only; `diagnose:dates` changes nothing without `--apply`.

## API service

A thin, dependency-free HTTP server (Node's built-in `http`, no extra packages) that serves the timeline engine and full-text search over the local `events.sqlite`. All access is read-only, so the same static file can back this server or an in-browser applet.

```powershell
npm run serve            # http://localhost:8787  (override with PORT)
```

Deployed as a Docker web service on **Render** (see `render.yaml`), which is the only live API point.

**Every route is under `/v1`.** There is no root document and no unversioned alias; anything else returns `404`.

| Method / path | Purpose |
| --- | --- |
| `GET /v1/health` | liveness check; does not touch the database |
| `GET /v1/meta` | dataset provenance + engine defaults, config bounds, and the request limits below |
| `GET /v1/search?q=<term>&limit=<n>` | full-text search (default 25, max 100) |
| `POST /v1/timeline` | body = `TimelineInput` JSON -> `Timeline` JSON; add `?format=markdown` for Markdown |
| `POST /v1/feedback` | a coarsened thumbs up/down, forwarded to a Notion Worker; never stored here |

`POST /v1/timeline` takes a person's life segments and returns the ranked, cited timeline:

```json
{
  "person": "Ada Example",
  "segments": [
    { "label": "Childhood", "place": { "name": "Chicago", "lat": 41.8819, "lng": -87.6278 }, "start": "1939", "end": "1945" }
  ]
}
```

The response is the exact `Timeline` object `getTimeline()` returns (`entries` + `meta` + `datasetVersion`).

**`GET /v1/meta` is not a deployment check.** It reports the short `dataset_version` from the `meta` table (`dump-v0.6`), which does not change when the dataset is rescored, repruned or re-uploaded - so it reads identically before and after a refresh. Confirming that new data is live means querying an actual row.

### Access control

**CORS is not open.** Browser requests are refused unless their `Origin` is in the `ALLOWED_ORIGIN` allowlist, and once that allowlist is set, a `POST` arriving with no `Origin` header at all is refused too (set `ALLOW_NO_ORIGIN_POST=true` to permit `curl` and CI). Set `ALLOWED_ORIGIN` in the Render dashboard to the Circa origin before expecting the client to work -- until then the API is healthy and every browser call fails, which looks exactly like an outage.

The live client is `https://circatimeline.org` (with `https://www.circatimeline.org` and the older `https://circa-2cg.pages.dev` also allowed). Matching is exact, so Cloudflare Pages **preview** deployments -- which get a generated hostname per build -- are refused by design. A preview that loads but fails at the timeline step is behaving correctly; do not widen the allowlist to a wildcard to make it work.

Local dev origins (`localhost:5173/4173`) require an explicit `ALLOW_DEV_ORIGINS=true` **and** a non-production `NODE_ENV`. They are not admitted merely because `ALLOWED_ORIGIN` is unset.

### Request limits

Rate limiting is enforced **inside this process**. The free Render plan has no WAF or edge rate limiter, and the client is a static bundle -- a limit in client code is not a limit. Requests are keyed on the client address derived from `X-Forwarded-For` per `TRUSTED_PROXY_HOPS` (see `net.ts`), IPv6 collapsed to a `/64` so a single allocation cannot rotate addresses to buy more budget.

`TRUSTED_PROXY_HOPS` is counted from the **right** of the header, because a caller can prepend anything they like to the left. Its value is **measured, not assumed**: Render fronts its services with Cloudflare, so three layers append to `X-Forwarded-For`, not one. With the wrong count the limiter keys on infrastructure addresses drawn from a rotating pool and silently stops limiting anything -- a 65-request burst returned 65 x `200` with no `429` at all under both `1` and `2`. At `3` the same burst returns 60 x `200` + 5 x `429`, which is the acceptance test; re-run it if the platform ever changes what sits in front of the service, because the failure is invisible otherwise. `render.yaml` records the measurement.

| Guard | Default | Env |
| --- | --- | --- |
| Requests per client per window | 60 / 60s | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW` |
| Votes per client per window | 10 / 60s | `FEEDBACK_RATE_LIMIT_MAX`, `FEEDBACK_RATE_LIMIT_WINDOW` |
| Tracked rate-limit keys | 10000 | `MAX_RATE_LIMIT_KEYS` |
| Proxy hops in front of the process | 3 (Cloudflare edge -> Render LB -> node; measured) | `TRUSTED_PROXY_HOPS` |
| Concurrent timeline builds | 4, then `503` | `MAX_CONCURRENT_TIMELINES` |
| Request body | 64 KB | `MAX_BODY_BYTES` |
| Request timeout | 15s | `REQUEST_TIMEOUT_MS` |
| Segments per request | 40 | - |
| Years per segment | 300 | `MAX_SEGMENT_SPAN_YEARS` |
| Years across all segments | 3000 | `MAX_TOTAL_SPAN_YEARS` |

Invalid input (missing segments, non-numeric coordinates, unparseable dates, an out-of-range or over-long year span) returns a `400` with a specific message. Dates are parsed with the engine's own parser at validation time, so a request that passes validation cannot fail differently inside the engine.

### The `config` object

`POST /v1/timeline` accepts a partial `EngineConfig` to override query-time tuning. It is **allowlisted and clamped**, not merely shape-checked: an unknown key is a `400` naming the accepted keys, and every value must fall inside the bounds below. `GET /v1/meta` publishes both `defaults` and `configBounds` so a client can stay inside them without hardcoding either.

| Key | Type | Range |
| --- | --- | --- |
| `significanceFloor` | number | 0.01 - 1 |
| `scopeFloor.{local,regional,national,global,universal}` | number | 0.01 - 1 |
| `maxPerSegment` | integer | 1 - 50 |
| `maxSegments` | integer | 1 - 40 |
| `scopeQuota.{local,regional,national,global}` | integer | 0 - 25 |
| `personQuota` | integer | 0 - 25 |
| `universalQuota` | integer | 0 - 10 |
| `categoryWeights.*` | number | 0 - 1 |
| `foundingKindWeights.*` | number | 0 - 1 |

`scopeQuota` accepts four scopes, not five, and that is deliberate: `core.ts` never reads `cfg.scopeQuota.universal`. The universal tier is filled from `universalQuota` instead, so adding a fifth entry here would be a knob that silently does nothing.

The engine applies its own independent floor (`ABSOLUTE_MIN_FLOOR`) and a per-segment candidate-row ceiling (`MAX_CANDIDATE_ROWS`), so a caller reaching `getTimeline` directly -- bypassing the API -- still cannot ask it to scan the whole table.

### Dataset integrity

The image downloads `events.sqlite` from the `dataset-latest` GitHub release, a mutable tag. Pass the expected digest to pin it:

```bash
docker build --build-arg DATASET_SHA256=$(sha256sum events.sqlite | cut -d' ' -f1) -t geohistory-api .
```

Builds without it still work and print the digest of what shipped, with a warning.

**On Render it is not really optional.** `render.yaml` pins `DATASET_SHA256` as a service environment variable (Render has no separate Docker build-args screen; an env var is supplied to the build and binds to the matching `ARG`), and it does a second job there: build args participate in the layer cache key. Refresh the release asset without changing that value and every later deploy can reuse the cached download layer, shipping an old database while reporting success. `DATASET_VERSION` cannot be relied on for this - it is hand-edited and drifts out of step with what was actually uploaded.

Refresh the pin whenever the asset changes:

```bash
gh release view dataset-latest --json assets \
  --jq '.assets[] | select(.name=="events.sqlite") | .digest'
```

And read the asset's own `updatedAt` / `size` / `digest` rather than the release title or notes when checking what is published. The label is written by hand; the asset metadata is not.

## Repo layout

| File | Purpose |
| --- | --- |
| `schema.sql` | SQLite schema (`events`, `places`, `meta`) + `events_fts` search index |
| `ingest.ts` | Sample harvester via live SPARQL (1900-present) |
| `ingest-dump.ts` | Comprehensive harvester from a local Wikidata dump (true date precision) |
| `migrate-v06.ts` | Schema migration to the v0.6 shape (`npm run migrate`) |
| `seed.ts` | Curated seed loader - merges hand-authored rows from `seed/*.json` into `events`, idempotently (`npm run seed`) |
| `seed/*.json` | Curated event rows exported from the Notion review table (`milestone` inventions and the `universal` tier, era-bucketed into multiple files) |
| `score.ts` | Build-time scorer: scope + significance (pass 1), reach + bbox (pass 2); preserves authored scope on seed rows |
| `rescope-foundings.ts` | Re-derives founding scope from `founding_kind` (`npm run rescope:foundings`) |
| `expand-participants.ts` | Per-participant sibling rows for multi-party events (`npm run expand:participants`) |
| `display-titles.ts` | Materializes `display_title` - "Birth of X", "Founding of X" (`npm run titles`) |
| `prune.ts` | Review + delete low-notability rows within one category without a full re-ingest (`npm run prune <category> [floor] [apply]`) |
| `prune-media.ts` | Drops film / TV / franchise rows (`npm run prune:media`) |
| `prune-series.ts` | Drops recurring series instances (`npm run prune:series`) |
| `prune-seed-dupes.ts` | Drops seed rows the dump already covers (`npm run prune:dupes`) |
| `merge-universal-dupes.ts` | Merges a universal row with its global twin, keeping the better blurb |
| `core.ts` | Deterministic event-radius timeline engine (`getTimeline`) - importable, no side effects |
| `phase-display.ts` | Resolves a ranged event's display date from its phase; vendored into Circa |
| `timeline.ts` | CLI demo: runs `getTimeline` against `events.sqlite` |
| `search.ts` | CLI full-text search over the dataset (`events_fts`) |
| `stats.ts` | Read-only dataset diagnostics (counts by category / precision / scope + provenance) |
| `diagnose-defects.ts` | Read-only defect sweep (`npm run diagnose`) |
| `diagnose-date-ranges.ts` | Read-only report on rows that look ranged but carry no `date_end` (`npm run diagnose:dates`) |
| `diagnostics/v06-baseline.ts` | The v0.6 baseline composition report (`npm run diag`) |
| `server.ts` | JSON API wrapping `getTimeline` + search over `events.sqlite` (`npm run serve`) |
| `net.ts` | Client-address derivation behind a proxy + the shared, bounded rate limiter |
| `validate-config.ts` | Allowlist + clamp for the request `config` object |
| `feedback.ts` | Vote validation, signing, and forwarding for `POST /v1/feedback` (writes nothing locally) |
| `docs/engine-invariants.md` | Invariants in `core.ts` that are easy to break and expensive to debug |
| `Dockerfile` | Image for the Render service; downloads and verifies `events.sqlite` at build time |
| `render.yaml` | Render blueprint for the deployed service |

`events.sqlite` is a build artifact (gitignored) and is published via GitHub Releases.

The `Dockerfile` copies application sources **by explicit filename**. A new module reached from `server.ts` at any depth - including one imported by `core.ts` rather than by `server.ts` itself - has to be added to that `COPY` line, or the image builds clean, passes every check, and then exits at startup with `ERR_MODULE_NOT_FOUND`. This has happened twice.

## Relevance tuning

Query-time knobs live in `DEFAULT_CONFIG` in `core.ts` (no rescoring needed):

- `significanceFloor` (0.15) - drop events below this era-normalized importance.
- `scopeFloor` (`local 0.05 / regional 0.15 / national 0.15 / global 0.2 / universal 0.85`) - per-tier override of the floor above, because dump events, humans, and curated seed rows enter on three different notability scales. The universal floor is deliberately severe: that tier is distance-blind, so significance is the only gate left on it.
- `scopeQuota` (`local 4 / regional 3 / national 4 / global 5`) plus `personQuota` (2) and `universalQuota` (2) - per-segment cap **per tier**; the flood control that guarantees a blend of local color + world context. Births and deaths draw from their own `person` tier rather than competing with local history. `universal` is **not** part of the round-robin fill - it is sliced off under its own quota before the round robin runs, which is also why universal rows never reach the temporal-spread pass. Assuming otherwise has already cost one wrong root-cause diagnosis.
- `categoryWeights` (`birth 0.4 / death 0.5 / founding 0.7`) and `foundingKindWeights` (`settlement 0.35 / institution 0.5 / subnational 0.9 / country 0.9`) - rank multipliers; celebrity births and bare village incorporations are demoted vs. substantive history.

Scope thresholds live in `score.ts` pass 1; the reach formula in pass 2. Retuning reach is a no-LLM patch: `npm run score reach`.

## Tests

There is no test runner here by design. This repository is the dataset, its pipeline, and a read-only API over it; correctness of the *data* is checked by `npm run stats`, the diagnostics above, and the prune tooling's dry runs, all of which report on a real build rather than a fixture. `npx tsc --noEmit` in CI (`.github/workflows/ci.yml`, alongside a hadolint pass over the `Dockerfile`) is the automated gate on the code, and the API's own validation layer is written to fail closed. Behavioral tests live in the client (Circa), where the assertions are cheap and the fixtures are small.

The corollary is that nothing here exercises the running service, which is exactly how the rate limiter shipped inert: a typecheck cannot notice that a limit never fires. CI also cannot build the image, because the build needs `events.sqlite`, which is gitignored - so the `Dockerfile`'s source list is only ever verified by a deploy. Deployment-shaped guarantees have to be measured against the live instance -- see the burst under Request limits.

## Known refinements (planned)

- **Coordinate-less events** - events without their own `P625` (many elections, treaties, and agreements) are currently dropped, so those categories are under-represented; a country-centroid (`P17`) fallback would capture them.
- **Scope threshold skew** - for scored (non-seed) categories, `scope` is derived from a notability threshold rather than the event's true geographic nature. This can misclassify comparably important events into different reach tiers (e.g. two national elections a few notability points apart landing in `national` vs. `regional`), under-serving the lower-scoring one outside its home region. Needs its own tuning pass, separate from significance.
- **Missing `date_end`** - `npm run diagnose:dates` currently lists roughly 1,500 rows that read as ranged (wars, reigns, movements) but carry no end date, so they render as points.
- **LLM semantic scoring** - pass 1 is currently a structural baseline (category + fame + decade percentile); a batched, cached LLM refiner will improve `scope` and `significance`.
- **Place hierarchy** - matching is coordinate-based; the `places` admin hierarchy will be repopulated via coordinate reverse-geocoding.
- **R-tree spatial index** - the portable bbox columns can be upgraded to a SQLite R-tree at full scale.
- **VACUUM** - the published file is ~995 MB for 116,295 rows, mostly free pages left behind by five prune passes. SQLite does not return them without a `VACUUM`, which is deliberately not done in the image build.
- **BCE / ancient events** - the dump ingester currently skips BCE dates.

## License

- **Code:** MIT (see `LICENSE`).
- **Data:** derived from Wikidata (CC0) with Wikipedia links; distributed under **CC BY-SA** with per-item attribution via `source_url`.
