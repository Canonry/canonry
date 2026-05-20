# AI Engagement Attribution — Design

## Status

**Proposed (draft).** Design only — no code in this change.

This doc specifies the correlation layer that joins Canonry's now-distinct AI
traffic channels into a single per-engine engagement funnel. It is the layer
two earlier plans gestured at but never specified:

- [`server-side-ai-traffic-ingestion.md`](./server-side-ai-traffic-ingestion.md)
  rollout step 8 ("Intelligence correlations").
- [`ai-attribution-research.md`](./ai-attribution-research.md) Steps 2C
  (citation-to-traffic gap) and 2D (GSC ⨝ citation overlap).

Depends on:

- **#611** (`ai_user_fetch_events_hourly` — in review) — splits bulk crawl from
  per-user fetch so Stage 1 and Stage 2 of the funnel are distinct.
- **#598** (AI crawler IP ranges — merged) — supplies the `verified`
  promotion the funnel filters/weights on.

Last updated: 2026-05-20.

## Context

Canonry now observes AI engagement across five stores. None of them are joined:

| Signal | Store | Pipeline |
|---|---|---|
| Bulk crawl | `crawler_events_hourly` | server-side traffic |
| Live per-user fetch | `ai_user_fetch_events_hourly` | server-side traffic (new in #611) |
| Answer citation / mention | `query_snapshots` | answer-visibility sweep |
| Human click-through | `ai_referral_events_hourly` | server-side traffic |
| Session → conversion | `ga_*` rollups | GA4 |

Before #611, bulk crawl and per-user fetch were welded into one "crawler hits"
number — an operator could not tell GPTBot indexing them apart from a real
person having ChatGPT read their page. The two have opposite business meaning.
#611 unwinds that conflation. With the channels finally clean, the missing
piece is a layer that **reconciles them into one per-engine funnel**.

## The engagement funnel

```
  Phase A  ├──────────── read-time reconciliation ────────────┤  Phase B ├────┤

  STAGE 1        STAGE 2          STAGE 3        STAGE 4          STAGE 5
  Indexed   →    Fetched-live →   Cited      →   Referred    →    Converted
  ───────        ────────────     ─────          ────────         ─────────
  AI crawled     AI read it       AI cites       a human          the session
  the page       live for a       the domain     clicked through  produced a
  (bulk)         real user        in its answer  from an AI       conversion
                                                 surface
     │              │                │              │                │
     ▼              ▼                ▼              ▼                ▼
  crawler_       ai_user_fetch_   query_         ai_referral_      ga_*
  events_hourly  events_hourly    snapshots      events_hourly     rollups
     │              │                │              │                │
  Channel 1      Channel 2        sweep          Channel 3         GA4
     └─ #611 made these two disjoint ─┘

  supply-side ◄──────────────────────────────────────────► demand-side
```

Today these are five numbers on three or four different screens; a human reads
them side-by-side and infers a funnel in their head. This doc makes that funnel
a first-class, agent-readable surface.

## Goals

1. **One per-engine view** — for each AI engine, how far it carries the domain
   through indexed → fetched-live → cited → referred → converted.
2. **Single-call read** — API + CLI + MCP, per the agent-first contract. An
   agent answers "is AI working for this client?" in one request.
3. **Honest correlational framing** — never claim a row-level causal link.
4. **Volume-graceful** — Stages 1–4 work at any traffic volume; the conversion
   tail degrades to `null` (not a fake `$0`) below the volume floor.

## Non-Goals

- **No row-level deterministic join.** There is no shared identifier linking a
  `ChatGPT-User` fetch to the `chatgpt.com` referral session it may have
  produced. Manufacturing one would be fiction. See "The honest limit" below.
- **No T0-anchored lift model.** `ai-attribution-research.md` finding 1 already
  rejected this — `query_snapshots.created_at` is sweep cadence, not citation
  start. This doc does not revive it.
- **No new traffic ingestion.** Consumes existing rollups only.
- **No revenue claim without GA conversion data** — that is Phase B, and only
  above the volume floor.

## The join model

### Keystone keys

| Stage | Store | Path key | Engine key |
|---|---|---|---|
| Indexed | `crawler_events_hourly` | `path_normalized` | `operator` |
| Fetched-live | `ai_user_fetch_events_hourly` | `path_normalized` | `operator` |
| Cited | `query_snapshots` | — (query / domain) | `provider` |
| Referred | `ai_referral_events_hourly` | `landing_path_normalized` | `operator` |
| Converted | `ga_*` rollups | landing page | source / medium |

`path_normalized` and `landing_path_normalized` are the same
normalized-path concept (`normalizeUrlPath()`, shipped in #373) — joinable
directly. The funnel is **per-engine**; Stages indexed / fetched / referred
additionally break down by path. "Cited" is per-engine-per-query, not per-path
(and Gemini is domain-only — see `ai-attribution-research.md` finding 2), so it
is reported at engine granularity.

### Canonical engine identity (the glue piece)

The three pipelines name the same engine three different ways:

- traffic crawl / fetch / referral → `operator` (e.g. `"OpenAI"`)
- answer-visibility sweep → `provider` (e.g. `"openai"`)
- traffic referral additionally carries a finer `product` (e.g. `"ChatGPT"`)

Nothing joins until these resolve to one identity. **Phase A's first
deliverable is a pure lookup** in `packages/contracts/src/engine-identity.ts`:
an `AiEngine` enum plus `resolveEngine(operator | provider | product) →
AiEngine`. Per the Shared Utilities rule it lives in `contracts` and is
imported by every consumer; per the Enum Constants rule the union is derived
from a Zod schema.

### The honest limit

You cannot prove a specific `ChatGPT-User` fetch *caused* a specific
`chatgpt.com` referral session — they are separate hits with no shared id. The
funnel is **correlational at the (engine, path, time-window) aggregate**, the
same epistemic footing as any multi-touch attribution model. Every surface must
label it as such; insight copy follows the evidence-weighted phrasing already
specified in `server-side-ai-traffic-ingestion.md` → "Insight Rules" ("`/guide`
is cited but has no detectable AI referral clicks" — never "X caused Y").

## Phase A — Reconciliation (the next step)

Read-side only. **No schema change.** Joins Channels 1 + 2 + 3 and the sweep
into a per-engine funnel; the data already exists once #611 is merged, so this
is primarily one aggregate query plus the engine-identity map.

### Output

```json
GET /api/v1/projects/gjelina-hotel/traffic/engagement?window=7d
{
  "windowStart": "2026-05-13T00:00:00Z",
  "windowEnd":   "2026-05-20T00:00:00Z",
  "byEngine": [
    {
      "engine":      "openai",
      "indexed":     { "paths": 47, "hits": 612 },
      "fetchedLive": { "paths": 12, "hits": 88, "verifiedHits": 81 },
      "cited":       { "queries": 0, "trackedQueries": 8 },
      "referred":    { "paths": 9,  "sessions": 93 },
      "converted":   null
    }
  ]
}
```

### What it answers immediately

The gjelina-hotel baseline contradiction — ChatGPT drives ≈90% of AI referral
traffic, yet the sweep shows OpenAI citing **0 of 8** tracked queries — stops
being a contradiction. The funnel reads it plainly: `fetchedLive` and
`referred` both high, `cited` near zero → the **tracked-query basket is wrong,
not the visibility**. That is a discovery / content action, and it can be
surfaced automatically instead of requiring an analyst to notice it.

### Implementation

| Layer | File(s) | Change |
|---|---|---|
| Contracts | `packages/contracts/src/engine-identity.ts` *(new)* | `AiEngine` enum + `resolveEngine()` |
| Contracts | `packages/contracts/src/traffic.ts` | `AiEngagementFunnelRow`, `AiEngagementResponse` DTOs + Zod schemas |
| API | `packages/api-routes/src/traffic.ts` | `GET /projects/:name/traffic/engagement?window=7d` — single endpoint, read-time join; register a typed `jsonResponse(...)` schema |
| CLI | `packages/canonry/src/commands/traffic.ts` | `canonry traffic engagement <project> [--window 7d] [--format json]` |
| Client | `packages/canonry/src/client.ts` | `getTrafficEngagement(name, window)` returning the typed DTO |
| MCP | `packages/canonry/src/mcp/tool-registry.ts` | `canonry_traffic_engagement` under the `monitoring` toolkit |
| UI | `apps/web/src/pages/TrafficPage.tsx` | per-engine funnel block; consumes the endpoint, **no UI-side math** |
| Report *(optional)* | `report.ts` + `report-renderer.ts` + `ReportPage.tsx` | funnel section — if added, both renderers move together (Report parity rule) |
| Tests | per layer | engine-resolve table; join math (disjoint counts, zero/partial data, rounding); CLI `--format json` contract |

Estimated size: ~500–700 LOC. No migration.

### Prerequisite cleanup carried from the #611 review

#611 surfaces `ai_user_fetch_events_hourly` to the Traffic page and the project
page's `ActivitySection`, but **not** to `report.ts` `buildServerActivity`
(read-side gap flagged in the #611 review). Fix it inside #611 or as an
immediate follow-up — otherwise the report and this funnel will disagree on
fetched-live counts.

## Phase B — Outcome attribution (the larger build)

Crosses the GA ↔ traffic pipeline boundary. Joins `ai_referral_events_hourly`
to GA4 sessions on (engine, landing path, day) and attributes GA4 conversions
back to the originating engine. The funnel row gains `converted:
{ sessions, conversions, value }`. This is the "prove AI drove revenue"
deliverable.

Constraints carried forward from `ai-attribution-research.md`:

- **Volume floor (finding 3).** Sites below ≈3,000 sessions/month cannot
  produce a detectable conversion signal — weekly variance dominates. Phase B
  output is `null` below the floor, never a fabricated `$0 from AI`.
- **Presence-window model, not T0 (finding 1).** Compare cited/referred pages
  against a pre-presence baseline or an uncited cohort; no sweep-timestamp
  anchoring.
- GA4 referral attribution remains a **lower bound** — referrer-stripped
  `Direct` traffic is not reclassified here. Server-side `ai_referral` is the
  stronger evidence and already enters the funnel at the Referred stage.

Phase B is explicitly out of scope for the first PR. It is specified now so
Phase A's DTO leaves room for it (`converted` is nullable from day one).

## Considered and rejected

- **Row-level fetch → referral join.** No shared identifier exists. Rejected —
  see "The honest limit".
- **A materialized `ai_engagement_hourly` table.** Premature for Phase A; the
  read-time join is cheap at current rollup sizes. Reconsider for Phase B, or
  if the endpoint becomes slow.
- **T0-windowed lift attribution.** Already rejected in
  `ai-attribution-research.md` finding 1; not revived.
- **Extending `ai-attribution-research.md` Steps 2C/2D in place.** That doc is
  GA-pipeline-centric and predates the clean server-side channels. This is the
  same goal re-grounded on the post-#611 data model; the two should be
  reconciled when Phase A lands (2C/2D most likely collapse into Phase B).

## Open questions

1. **Phase B correlation window.** How many days after a referral may a
   conversion still be attributed? Needs a look at GA4 conversion-lag data.
2. **Engine-map upkeep.** `engine-identity.ts` must stay in sync as new bot
   rules, referrer rules, and providers are added. Add a row to the AGENTS.md
   "Keeping Documentation Current" table when Phase A ships.
3. **Citation-stage granularity.** "Cited" is per-query; the other stages are
   per-path. Should the funnel attempt a query → page mapping, or keep citation
   at engine level? Lean engine-level for Phase A; revisit with Phase B.
4. **Endpoint placement.** `traffic/engagement` keeps it in the established
   traffic namespace but undersells the citation and GA inputs. Acceptable for
   now; revisit if a broader `engagement` surface emerges.

## Files referenced

- [`packages/db/src/schema.ts`](../packages/db/src/schema.ts) — `crawler_events_hourly`, `ai_user_fetch_events_hourly` (#611), `ai_referral_events_hourly`, `query_snapshots`, `ga_*` rollups
- [`packages/integration-traffic/src/classifier.ts`](../packages/integration-traffic/src/classifier.ts) — channel classification; source of the `operator` identity
- [`packages/contracts/src/url-normalize.ts`](../packages/contracts/src/url-normalize.ts) — `normalizeUrlPath()`, the shared path join key
- [`packages/api-routes/src/traffic.ts`](../packages/api-routes/src/traffic.ts) — existing traffic read endpoints; the engagement endpoint sits beside them
- [`packages/api-routes/src/report.ts`](../packages/api-routes/src/report.ts) — `buildServerActivity` (the #611 read-side gap)
- [`server-side-ai-traffic-ingestion.md`](./server-side-ai-traffic-ingestion.md) — ingestion plan; this doc is its rollout step 8
- [`ai-attribution-research.md`](./ai-attribution-research.md) — GA-side attribution research; findings 1–3 constrain this doc
