# Nearby events (`POST /v1/nearby`)

A generic proximity query over the same read-only `events.sqlite` the timeline
engine uses. It answers one question: **which recorded events happened closest
to this point?**

## Why it is not the timeline query

| | Timeline (`core.ts`) | Nearby (`nearby.ts`) |
| --- | --- | --- |
| Predicate | caller's point is inside the event's reach circle | event's own point is within N km of the caller |
| Columns | `reach_min_lat`..`reach_max_lng`, `reach_km` | `lat`, `lng` |
| Index | `idx_events_reach_box` | `idx_events_lat_lng` |
| Ranking | significance within per-scope quotas | distance, then date, then id |
| `universal` scope | drawn deliberately, distance-blind | excluded by default; it is not *near* anything |

A national election reaches its whole country, so the timeline engine is right
to surface it 600 km away, and a proximity list would be wrong to. Reusing the
reach box here would have produced a "nearby" list dominated by rows that are
not nearby.

## Why POST, for a read-only query

The route is `POST` and the coordinate travels in the JSON body. This is not a
write: nothing is stored, and the response carries `Cache-Control: no-store`
like every other route.

A `GET /v1/nearby?lat=...&lng=...` would put a person's precise location in a
URL, and URLs are the most-copied, most-retained part of an HTTP request:
browser history, `Referer` headers, proxy and CDN access logs, and platform
request logs all keep the query string long after the response is gone. The
governing rule for this feature is that a precise coordinate must never appear
in a URL, so the method follows the privacy requirement rather than the other
way round.

The cost is one deliberate deviation from HTTP convention, which is recorded
here so a later reader does not "fix" it.

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
| `lat` | yes | - | -90..90 |
| `lng` | yes | - | -180..180 |
| `radiusKm` | yes | - | 0.1..150 |
| `limit` | no | 12 | 5..25 |
| `significanceFloor` | no | 0.05 | 0.01..1 |
| `coordinateMode` | no | `direct` | `direct` \| `all` |
| `excludeCategories` | no | `[]` | <= 20 names, <= 40 chars each |
| `includeUniversal` | no | `false` | boolean |
| `fromYear` / `toYear` | no | - | year 1..current+1, span <= 1000 years |

Unknown fields return `400 Unknown nearby field(s): ...`. No error message ever
contains the coordinate.

### `coordinateMode`

`direct` admits rows whose point is the event's own: `coord_source` of `P625`
(coordinate location), `P276` (stated location), or `NULL` (a curated seed row).
It excludes `P17` / `P495` (country centroids) and `P19` / `P20` (a person's
birth or death place). A country centroid is a real coordinate for a row that
happened *somewhere in that country*, which is fine for a reach-based timeline
and actively misleading for a proximity list -- it would make an arbitrary rural
point the most historic place in the nation.

`all` disables the filter so the difference can be measured rather than assumed.

## Response

```json
{
  "datasetVersion": "dump-v0.6",
  "engine": "geohistory-nearby@0.1.0",
  "radiusKm": 15,
  "coordinateMode": "direct",
  "significanceFloor": 0.05,
  "totalWithinRadius": 41,
  "returned": 12,
  "entries": [ { "id": "Q...", "distanceKm": 1.42, "...": "..." } ]
}
```

`totalWithinRadius` counts everything that passed the filters inside the radius,
before the limit cut, so a client can tell "there are only three" from "we showed
you twelve of four hundred" without a second request.

## Ordering

Selection is by **distance**; presentation is by **date**.

1. Bounding-box prefilter (indexed), then an exact haversine test at
   `R = 6371 km` -- the same radius `core.ts` uses.
2. Sort by distance, then `date_start`, then `id`.
3. Cut to `limit`.
4. Re-sort the selected rows by `date_start`, then distance, then `id`.

Step 4 makes the returned list read as local history. Sorting the whole
candidate set by date and then cutting would return the oldest rows in the box,
which is a different question.

The id tiebreak is not decoration: many rows share a city-centre coordinate, and
without it the same request could return a different list on the same data.

## Boundaries

- **Antimeridian.** A box spanning +/-180 is split into two longitude ranges and
  OR-ed. Without this, a location at 179.9E silently returns nothing.
- **Poles.** When the box would contain a pole, the longitude filter is dropped
  and the latitude band plus the exact distance test does the work.
- **Empty is a real answer.** Open ocean returns `entries: []` with
  `totalWithinRadius: 0`. The module does not widen the radius to avoid it.

## Overflow, not truncation

The candidate query reads at most `10000 + 1` rows. If the extra row comes back,
the request fails with `422 Candidate set exceeds 10000 rows; narrow the radius
or date window.` Returning a full page instead would be indistinguishable from a
complete result, and a silently truncated "nearest" list is the one failure mode
that is both invisible and wrong.

## What lives in the client, not here

This module holds no product policy. Radius ladders ("try 5, then 15, then 50,
then 150 km"), category taste ("most people do not want a list of births"),
empty-state copy and map behaviour are all client decisions. `nearby.ts` answers
one question at one radius, truthfully, and lets the caller decide what to do
with the answer.

## Privacy

The coordinate is an input and never an output. It is not logged (access logs
record method, path, status, duration and a truncated IP only), not cached, not
stored, and never echoed in an error. `docs/engine-invariants.md` covers the
engine-side rules; this is the route-side one.

## Deployment note

`nearby.ts` is reached from `server.ts`, so it **must** appear in the
`Dockerfile`'s explicit `COPY` list. Omitting it produces an image that builds
clean, passes CI, and then exits at startup with `ERR_MODULE_NOT_FOUND`. That
has already happened twice with other modules.
