# Engine invariants

Things that are true about this codebase, are not obvious from reading any
single function, and have already caused a defect. Add to this file when a bug
turns out to have been "invisible but knowable".

---

## 1. Selection and presentation are different concerns

`core.ts` keys off dates in three places. They look interchangeable. They are
not.

| Site | Decides | Must key on |
| --- | --- | --- |
| `matches.sort` (pass 3) | **which** rows are drawn — feeds the tier pools and the universal slice | `dateStartISO` |
| `applyTemporalSpread` bins | **which** rows are drawn — ~6-year spread within a tier | `dateStartISO` |
| `entries.sort` (end of `getTimeline`) | the **order of output** | `displayDateISO` |
| `date`, `displayPrecision` | what the card **prints** | resolved display date |

**The invariant:** a field that exists for presentation must never enter a
comparator that decides membership. Selection depends on the event's own start
date; where a card renders is a downstream rendering decision.

### The regression this cost

Commit `3523c55` introduced `displayDateISO` (an `ends` card renders at
`date_end`, an `ongoing` card at the segment start) and keyed all four sites off
it at once. The Cold War (`Q8683`, universal, significance `1.0`,
1947-03-12 → 1991-12-26) then vanished from every fixture.

Why: it scores exactly `1.0`, and so do the other curated universal rows. Tied
on score, `matches.sort` falls through to the date tiebreak — which had moved
from **1947** to **1991**. That put it last among its tied peers, and
`universalQuota` is **2**, so `pools.universal.slice(0, 2)` dropped it. Nothing
errored; a row simply stopped existing.

The same mechanism removed the French and Indian War's `ends` card via the
spread bins.

**How it was found:** render the same fixture against `main`'s `core.ts` and
against the branch, and diff. Do that *before* theorising. The first hypothesis
(that `applyTemporalSpread` was at fault) was wrong for the reason in §2.

---

## 2. The universal tier bypasses the round-robin entirely

`applyTemporalSpread` is applied only over `TIER_ORDER`
(`local, regional, national, global, person`). **Universal rows never reach
it**, and never pass through the round-robin fill either. They are drawn
additively:

```ts
const universalKept = pools.universal.slice(0, cfg.universalQuota);
```

Consequences:

- Changing spread behaviour cannot affect universal rows. Do not explain a
  universal-row bug with a spread change.
- Because the draw is a bare `slice` of a score-sorted pool, **ordering inside
  the pool is the entire selection algorithm** for that tier.
- With `universalQuota: 2` and multiple hand-authored rows at significance
  `1.0`, the *tiebreak* decides what ships. Score does no work at all there.

---

## 3. Ties ultimately resolve on QID string order

The last comparator in both sorts is `a.id < b.id`. For dump rows that is a
QID, so a tie is broken by the lexicographic order of an arbitrary identifier —
`Q154697` beats `Q8683` because `1` sorts before `8`. This is deterministic,
which is what it was chosen for, but it is not meaningful. Any change that
makes ties more common makes arbitrary outcomes more common.

---

## 4. Participant-expanded siblings compete with their own parent

`expand-participants.ts` emits rows like `Q154697#Q55290`
("French and Indian War — Catawba people") alongside the parent `Q154697`. They
carry the same dates and a lower score, but they occupy separate pool slots, so
a sibling at `0.797` can render while the parent at `0.947` does not. Four rows
sharing identical dates is normal in this corpus, not a data error.

---

## 5. The dataset does not ship with the code

`events.sqlite` is gitignored. Stage 1 of the `Dockerfile` downloads it from the
`dataset-latest` GitHub release. Therefore:

- **Merging code cannot change the data**, and re-uploading data cannot change
  the code. They are two independent deploys.
- Re-uploading to the same tag with `--clobber` leaves the release's
  `published_at` untouched. Only the **asset's** `updated_at` tells you when the
  data actually changed. The release *body* is hand-written and drifts.
- The asset's `download_count` is a cheap check on whether any build has ever
  fetched the current file. Zero downloads after an upload means the running
  image does not contain it.

### The cache-key trap

`ARG DATASET_VERSION` exists only to change the layer's cache key, because the
`curl` command is byte-identical across dataset swaps. If that ARG already
spells the *new* stamp — which happens whenever the value is updated in advance
of the upload — there is nothing left to bump, and the build silently reuses the
cached layer and ships the old database **while reporting success**.

Prefer pinning `DATASET_SHA256` to the digest of the uploaded file. It is also
an `ARG`, so it invalidates the cache automatically on every dataset change, and
unlike a version string it actually authenticates the download.

---

## 6. `/v1/meta` cannot verify which dataset shipped

The `meta` table stores `dataset_version = dump-v0.6` only. The long stamp
(`dump-v0.6+struct-v0.7.2+reach-v0.3+universal-v0.1+participants-v0.1+prune5`)
is assembled from separate meta keys, so `/v1/meta` reports the same string for
`prune4` and `prune5`. A deploy that shipped a stale database looks correct.

Until the full stamp is persisted, verify a deploy by **probing a row that only
exists in the new data** — for example requesting a 1947–1991 window and
checking that the Cold War returns with `tier: "universal"`.

---

## 7. Circa is coupled to this engine in two places that do not fail loudly

- `src/lib/types.ts` mirrors `TimelineEntry` and hardcodes the engine version it
  matches. Adding a field here is a two-repo change.
- `src/lib/feedback.test.ts` is **type-checked but never executed** —
  `vite.config.ts` includes only `tests/**`. Its fixture factory builds a
  `CircaEntry` with 23 required fields, so adding one engine field breaks it in
  a way `vitest` will not report and only `svelte-check` catches.

When adding a field to `TimelineEntry`, enumerate every required field of that
fixture in one pass. Fixing them one error at a time costs a round trip each.

---

## 8. Category taxonomy: the corpus disagrees with the spec

Stored categories are `founding, birth, death, conflict, event, disaster,
treaty, discovery, election, milestone`. The design spec's §2.1 list
(`war / disaster / politics / culture / science / epidemic / economy /
infrastructure / other`) has **no bucket for `founding` (47,116 rows) or
`birth`/`death` (48,302)** — together 82% of the corpus. The stored values are
authoritative; the spec is the thing that is wrong.

Also note the corpus census and the *rendered* census are close to inverted:
`founding` is 40% of rows but 12% of output, `treaty` is 1% of rows but 16% of
output, and `death`/`discovery`/`election` render nothing at all in a typical
timeline. Any UI that lists categories should derive them from what actually
rendered, not from corpus totals.

---

## 9. Local tooling gotchas

- `core.ts` on a Windows checkout is **CRLF**. Patch tooling that builds
  multi-line anchors joined with `\n` will silently match nothing.
- Scripts that `import` from this repo must live **inside** it. Node resolves
  bare specifiers from the script's own directory, not the working directory.
- `better-sqlite3` v11 runs with `SQLITE_DQS=0`: a double-quoted token in SQL is
  parsed as an identifier, so string literals must use single quotes.
- `render-fixture.ts` (`a | b | census | verify | trace`) is the acceptance
  harness. `verify` exits non-zero and greps rendered markdown, which is the
  only reason the Cold War regression was caught at all. Prefer extending it
  over writing a checklist by hand.
