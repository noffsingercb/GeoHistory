# GeoHistory MCP

This is a stdio [Model Context Protocol](https://modelcontextprotocol.io) server that fronts the existing read-only GeoHistory HTTP API. It exists so an MCP-capable agent can retrieve sourced, deterministic historical context for a place and date range instead of hallucinating it.

It is a thin adapter, not a second implementation. Every tool call maps to the same `/v1/meta`, `/v1/search`, or `/v1/timeline` routes the browser client uses, through the same rate limiter, the same clamp layer, and the same dataset. There is no model inference, no caching, no database access, and no write path.

## Tools

### `geohistory_timeline`

Call this when you have a place name, real latitude/longitude, and a date range for one or more life segments, and you need a ranked, cited historical timeline around them. It forwards to `POST /v1/timeline`.

Do not call it to geocode a place name into coordinates, to reach BCE history (the accepted year range starts at year 1), to vote or send feedback, or to generate historical claims the dataset does not already contain. Every returned entry keeps its own `sourceUrl` (which can be `null`) rather than a synthesized citation.

### `geohistory_search`

Call this to search event titles and blurbs through the upstream SQLite FTS5 index, typically to find candidate events before deciding whether a timeline call is useful. It forwards to `GET /v1/search`.

Do not call it as a general web search, a SQL interface, a geocoder, or a natural-language question-answering tool. It only matches literal FTS5 query text against titles and blurbs.

### `geohistory_meta`

Call this to read the live dataset version and build, engine defaults, and the accepted `config` bounds before tuning a `geohistory_timeline` call. It forwards to `GET /v1/meta`.

Do not treat it as a general health check, and do not assume the short `datasetVersion` string alone proves a specific new row is live — it does not change on every rescore or reprune.

All three tools are read-only (`readOnlyHint: true`, `destructiveHint: false`). There is no fourth tool; a write/feedback tool was explicitly out of scope for this server.

## Install and client configuration

This package has no published build step; the server runs directly from source with `tsx`. From the repo root:

```bash
npm install
```

Point an MCP host at the local server by running it through `npm run mcp` (which runs `tsx mcp/server.ts`), or by configuring the host to spawn it directly. Example host configuration (the exact file and key names vary by client):

```json
{
  "mcpServers": {
    "geohistory": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "/absolute/path/to/GeoHistory",
      "env": {
        "GEOHISTORY_API_URL": "https://geohistory-api.onrender.com",
        "GEOHISTORY_ORIGIN": "https://mcp.geohistory.invalid",
        "GEOHISTORY_TIMEOUT_MS": "15000"
      }
    }
  }
}
```

`cwd` must be an absolute path to a checkout of this repository; the server imports sibling files (`../validate-config.js`) by relative path.

Verify a local install without a host by running the bundled smoke client, which lists the tools, asserts the current schema bounds, and calls `geohistory_meta` and `geohistory_timeline` once each against the live API:

```bash
npm run mcp:smoke
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `GEOHISTORY_API_URL` | `https://geohistory-api.onrender.com` | Trailing slashes are stripped. Point this at a local `npm run serve` instance during development. |
| `GEOHISTORY_ORIGIN` | `https://mcp.geohistory.invalid` | Sent as the `Origin` header on the `POST /v1/timeline` request only, because this deployment rejects originless `POST` requests. `.invalid` is an IANA-reserved, deliberately non-resolving domain — it is a client identifier, not a real host, and it must already be present in the API's `ALLOWED_ORIGIN` allowlist. `GET /v1/meta` and `GET /v1/search` do not require an `Origin` header, so this variable does not affect them. |
| `GEOHISTORY_TIMEOUT_MS` | `15000` | Upstream request timeout in milliseconds. Must be a positive integer at or below `30000`; any other value (including `0`, negative, or non-numeric) falls back to the default rather than disabling the timeout. |

There is no API key. The upstream API has no authentication; an MCP client is an unauthenticated caller exactly like the browser client.

## Rate limits you will actually hit

The upstream API enforces its own per-client limiter (default 60 requests per 60 seconds) and a concurrent-timeline-build cap (default 4). This MCP server adds no separate limiter and no retry loop — it makes exactly one upstream request per tool call (`geohistory_search` makes two: one to `/v1/meta` for the current dataset version, one to `/v1/search`).

When the upstream limiter rejects a request, the tool call does not throw a protocol error. It returns a normal MCP tool result with `isError: true` and a body shaped like:

```json
{
  "ok": false,
  "tool": "geohistory_timeline",
  "datasetVersion": "dump-v0.6.1",
  "license": "GeoHistory data is licensed CC BY-SA; preserve each entry's sourceUrl attribution.",
  "error": {
    "kind": "rate_limited",
    "status": 429,
    "message": "...",
    "retryable": true,
    "retryAfterSeconds": 12
  }
}
```

The server does not automatically retry a `429`, a `503`, a timeout, or a network failure. Whether and when to retry is left to the calling agent, using `retryAfterSeconds` when it is present.

## Licensing and attribution

GeoHistory event data is derived from Wikidata (CC0) with Wikipedia links, and is distributed under **CC BY-SA**. Every successful tool response carries the exact line `GeoHistory data is licensed CC BY-SA; preserve each entry's sourceUrl attribution.` in its `license` field, and every timeline entry and search hit keeps its own nullable `sourceUrl` / `source_url` field unchanged from the upstream API.

Anything you build on top of a tool response — a rendered timeline, a generated summary, a downstream document — inherits that CC BY-SA obligation and must preserve the per-entry source attribution rather than presenting the content as if it were fact-checked or originated by the calling agent.

## What this will not do

- **BCE dates.** The upstream engine only accepts a resolved start year of 1 or later. A `geohistory_timeline` segment describing an ancient or BCE date will fail upstream validation, not silently shift into CE.
- **Coordinate-less event categories.** The underlying dataset only includes events that had their own Wikidata coordinate (`P625`) at ingest time. Many elections, treaties, and agreements lack one and were dropped during ingest; this server cannot retrieve what was never ingested, and there is no geocoding fallback.
- **A corpus balanced across event types.** The engine down-weights some categories by design — `categoryWeights` demotes births (0.4) and deaths (0.5) relative to other history, and `foundingKindWeights` further demotes bare settlement/institution foundings relative to national foundings. A timeline result is a ranked sample under those weights, not an exhaustive record of everything that happened.
- **Any inference.** There is no LLM, no summarization, and no semantic scoring anywhere in this server or the engine it calls. Every field returned is either a direct pass-through of a stored row or a value computed once, deterministically, at dataset build time.
