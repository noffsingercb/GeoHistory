# Nearby events (`POST /v1/nearby`)

A generic, read-only proximity query over `events.sqlite`. It selects by distance from one caller-supplied point and returns the selected set in date order. Radius escalation, category taste, copy, and map behavior belong to clients.

## Privacy

The coordinate is accepted only in a JSON POST body. It is never placed in a URL, logged, cached, stored, added to feedback, or echoed in an error. Responses use `Cache-Control: no-store`. Access logs contain method, normalized path, status, duration, and truncated client IP only.

## Request

```json
{
  "lat": 39.7392,
  "lng": -104.9903,
  "radiusKm": 15,
  "limit": 12,
  "significanceFloor": 0.05,
  "coordinateMode": "direct",
  "excludeCategories": ["birth", "death"],
  "includeUniversal": false,
  "fromYear": 1800,
  "toYear": 2026
}
```

| Field | Required | Default | Bounds |
| --- | --- | --- | --- |
| `lat` | yes | — | -90..90 |
| `lng` | yes | — | -180..180 |
| `radiusKm` | yes | — | 0.1..150 |
| `limit` | no | 12 | 5..25 |
| `significanceFloor` | no | 0.05 | 0.01..1 |
| `coordinateMode` | no | `direct` | `direct` or `all` |
| `excludeCategories` | no | `[]` | at most 20 non-empty names, 40 characters each |
| `includeUniversal` | no | `false` | boolean |
| `fromYear` / `toYear` | no | — | integer year 1..current UTC year+1; span at most 1000 |

Unknown fields return `400`. Candidate overflow returns `422 Candidate set exceeds 10000 rows; narrow the radius or date window.`

## Response identity

The envelope carries both `datasetVersion` and `datasetBuild`. The first is the short ingest label. The second identifies the layered artifact and changes when scoring, reach, or prune state changes. Clients that compare responses across requests must use `datasetBuild` and retain `datasetVersion` only as a compatibility fallback.

## Geometry and dates

The bounding box is a conservative superset of the exact circle. Latitude delta uses the minimum meridional scale, `radiusKm / 110.574`; longitude uses the widest latitude in the band. Antimeridian boxes split into two ranges. A box reaching a pole scans every longitude in its narrow latitude band. Exact membership then uses haversine distance with `R = 6371 km`, matching `core.ts`.

Date windows use inclusive year overlap:

```sql
CAST(substr(COALESCE(date_end, date_start), 1, 4) AS INTEGER) >= fromYear
AND CAST(substr(date_start, 1, 4) AS INTEGER) <= toYear
```

A ranged event that began before the window remains eligible when its end reaches into it.

## Deterministic ordering

1. Apply generic filters and exact radius.
2. Sort all matches by full-precision distance, `date_start`, then `id`.
3. Take `limit`.
4. Re-sort only that selected set by `date_start`, distance, then `id`.
5. Round response distance to two decimal places.

SQLite natural row order never decides membership or output order.

## Coordinate quality

`direct` admits `P625`, `P276`, and curated rows with a null coordinate source. It excludes country/origin centroids and birth/death-place fallbacks. `all` disables this filter so callers can measure the difference explicitly.

## Resource bounds

The SQL query asks for 10,001 candidates. The extra row proves overflow; it is never silently truncated into a plausible nearest list. The route shares the process-wide per-client limiter. `better-sqlite3` work is synchronous and therefore serialized by the Node event loop; production acceptance still includes a measured ceiling-case latency probe so that bounded does not get mistaken for cheap.

## Deployment

`nearby.ts` must remain in the Dockerfile runtime `COPY` list. CORS stays exact-match and dashboard-configured. Append the eventual Locus production origin to `ALLOWED_ORIGIN`; do not hardcode it, allow a wildcard, or admit generated preview hostnames.

## Regression coverage

`npm run test:nearby` covers conservative circle bounds, both antimeridian directions, polar all-longitude behavior, ranged-event overlap, full artifact identity, and the 10,001-row overflow path. CI runs those tests with typechecking and the Docker import-copy guard.
