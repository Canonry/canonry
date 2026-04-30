# AI Traffic Attribution — Research & Plan

## Status

- **Step 1 (URL/path normalization): COMPLETE.** Shipped in #373, #375, #376. Backfill runs on `canonry serve` startup.
- **Step 2A (four-channel breakdown panel): COMPLETE.** Shipped in #374, #377. Replaces the broken "Attributable AI visits" card with organic / direct / social / known-AI cells; the AI cell is rendered disjoint from Direct so known AI sources never inflate the Direct count.
- **Step 2B (citation visibility headline): NEXT — designed below.** Surfaces "cited by N of M engines per keyword" + a competitor-gap list as the headline AI metric.
- **Step 2C (citation-to-traffic gap), Step 2D (GSC ⨝ AI citation overlap): DEFERRED.** Re-scoped after 2B lands and we have a baseline citation-visibility view to extend.

Last updated: 2026-04-29 (after #377).

## Original goal

Move Canonry from the existing GA4-based AI referral classifier (which only catches AI traffic where the referrer header survives) toward a defensible model that surfaces AI-driven traffic landing in the `Direct` bucket. The motivating user observation: GA4 dashboards show heavy `Direct` traffic but zero AI-attributed sessions, even on sites where Canonry independently observes AI engines citing the domain. The current `fetchAiReferrals()` classifier is structurally incapable of attributing any `Direct` traffic, since it only matches on the GA4 source dimension.

## Findings that changed the architecture

### 1. Citation observation ≠ citation existence

`query_snapshots.created_at` is the timestamp of Canonry's sweep, not the time the AI engine started citing the URL. Sweeps happen on a cadence (typically daily); citations may have been live for hours-to-days before observation.

Implication: any windowed-lift attribution model anchored on `created_at` as T0 is fitting noise to noise. Originally a "30-min lift after citation" model was proposed — abandoned. The correct shape is a **presence window** model (lift over the entire `first_observed → last_observed` window vs the pre-presence baseline) or a **cohort comparison** model (cited URLs vs uncited URLs at the same moment). Both work on daily-grain data and don't depend on T0.

### 2. The Gemini opaque-redirect ceiling

Gemini's grounding sources return URIs of the form `https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ...` — opaque Google-internal redirect tokens, not base64-encoded URLs. The destination is recoverable only by following the redirect via HTTP, which is unreasonable at normalization time (slow, may rate-limit, tokens may expire).

The current Gemini normalizer ([`packages/provider-gemini/src/normalize.ts:298–304`](../packages/provider-gemini/src/normalize.ts)) falls back to extracting the destination domain from `source.title` (which Google reliably populates as the destination domain). This means **for Gemini, only domain-level data is recoverable** — paths cannot be retained without a follow-up HTTP request.

OpenAI, Claude, and Perplexity return real destination URLs in their respective grounding shapes:
- OpenAI: `output[].content[].annotations[].url`
- Claude: `content[].citations[].url`
- Perplexity: `search_results[].url`

So URL retention (the deferred change) is partial — works for 3 of 4 providers. Any UI that exposes per-URL citation data must label Gemini citations as "domain" not "URL" and document the API limitation in [`packages/provider-gemini/AGENTS.md`](../packages/provider-gemini/AGENTS.md).

### 3. The volume floor — live data shows current projects can't validate the model

Diagnostic run against a production canonry SQLite database in late April 2026, anonymized below:

```
Project A (small B2B service site) — 30 days
─────────────────────────────────────────────────────────
Total sessions:                  ~125
  organic:                        ~14
  non-organic:                   ~111
    excluded by clickId param:     ~9   (fbclid contamination)
    excluded by homepage:         ~88   (path_depth = 0)
    excluded by shallow path:     ~14   (depth = 1)
    DARK TRAFFIC ESTIMATE:          0

Citation tracking:
  Gemini cited the project's domain:  8 times in 22 days
  Claude / OpenAI / Perplexity:       0 citations across ~138 sweeps each

Project B (small SaaS landing) — 52 days
─────────────────────────────────────────────────────────
Total sessions:                  ~338
  organic:                        ~21
  non-organic:                   ~317
  AI referrals:                    0
```

Both projects are below the noise floor for a session-level dark-traffic model. A site with ~4 sessions/day cannot produce a detectable AI signal even if 100% of its non-organic traffic were AI — weekly variance dominates any plausible signal.

This means the "AI traffic estimate chart" we'd ship would be flat zero on the projects available for testing. Not because the model is wrong but because there's nothing to detect. The product story for small sites must lead with citation visibility (which works at any volume) rather than traffic attribution.

### 4. The fbclid / click-ID contamination problem

Project A has 17+ rows in `ga_traffic_snapshots` that are all variants of `/?fbclid=...` — the same homepage, fragmented by Facebook click IDs that GA4 didn't recognize as a known source. Today these inflate per-page tables and would inflate any "Direct to deep paths" predicate (the click IDs make `path_depth >= 2` after the `?`). This needs to be handled at URL normalization time regardless of whether AI attribution ever ships.

### 5. BigQuery Export — demoted from "essential" to "nice to have"

Initially proposed as essential for sub-day citation correlation. After the citation observation problem invalidated T0-anchored models, BQ Export's role shrunk. For the cohort/presence models, daily-grain Reports API is structurally sufficient.

What BQ Export still buys (in order of value):
1. **Validation** — profile the dark-traffic bucket (UA, time-of-day, geography) against the small known-AI-referral sample to confirm distributions match. Reports API can't do this at all.
2. **Cleaner predicate** — UA-based bot exclusion, in-app browser detection. ~10–20% false-positive reduction.
3. **Statistical power** — session-level rows give tighter CIs than daily aggregates.

Decision: **defer BQ Export**. Build with Reports API only. The constraint for Step 2 is "integrations we already have" — BQ Export is a new integration.

## What's been shipped

### Step 1 — Data hygiene (#373, #375, #376)

- `normalizeUrlPath()` in [`packages/contracts/src/url-normalize.ts`](../packages/contracts/src/url-normalize.ts) with 44 unit tests in [`packages/contracts/test/url-normalize.test.ts`](../packages/contracts/test/url-normalize.test.ts). Strip-list as specified (`fbclid, gclid, msclkid, ttclid, li_fat_id, igshid, yclid, dclid, gbraid, wbraid, mc_cid, mc_eid, _ga, _gl, gtm_latency, gtm_debug, utm_*`); trailing slash collapse (root excepted); `/index.html` and `/index.php` collapse to `/`; case preserved; remaining query params canonicalized.
- `landing_page_normalized` column on `ga_traffic_snapshots`, indexed `(project_id, date, landing_page_normalized)`. Migration in [`packages/db/src/migrate.ts:570`](../packages/db/src/migrate.ts).
- Read-side `COALESCE(landing_page_normalized, landing_page)` in [`packages/api-routes/src/ga.ts:580, 604, 706`](../packages/api-routes/src/ga.ts) so dashboards never see broken state during backfill.
- `canonry backfill normalized-paths` (idempotent) — runs automatically on `canonry serve` startup; safe to re-run via the CLI.
- `(not set)` handling and malformed-artifact recovery (#376) — guards against `&nbsp;` and other paste-introduced noise.

Visible win confirmed: per-page tables collapse the fbclid-fragmented homepage rows down to one entry. Total session counts unchanged.

### Step 2A — Four-channel breakdown panel (#374, #377)

- `fetchTrafficByLandingPage()` in [`packages/integration-google-analytics/src/ga4-client.ts:272–412`](../packages/integration-google-analytics/src/ga4-client.ts) now makes three GA4 Data API passes (total / organic-only / direct-only) and returns `directSessions` per row.
- `direct_sessions` column on `ga_traffic_snapshots`; the API endpoint `/projects/:name/ga/traffic` returns it.
- [`apps/web/src/components/project/TrafficSection.tsx:535–577`](../apps/web/src/components/project/TrafficSection.tsx) shows a four-stat "Channel breakdown": organic / social / direct / known AI referrers. The AI cell is **disjoint** — known AI sources are counted separately and never lumped into Direct, so the Direct number is honest.

What 2A intentionally did not do: it shows that "Direct" exists as a measurable bucket, but it does not tell the user whether their Direct traffic correlates with AI citation activity. That correlation is 2C — and only worth building once 2B gives us a credible citation-visibility surface to correlate against.

## Step 2B — Citation visibility headline (next)

### Why this next

Plan finding 3 (volume floor) said: *"The product story for small sites must lead with citation visibility (which works at any volume) rather than traffic attribution."* Step 2A laid the GA-side groundwork; 2B delivers on the product story by surfacing what actually works at small volume — citation coverage and competitor gaps — as the headline AI metric. Every project gets value from this regardless of session volume.

### Scope

Three outputs surfaced as one cohesive section:

1. **Per-project headline.** "Cited by X of N configured engines this period" — top-of-section metric, equivalent prominence to the channel breakdown. Pulls from existing project-level data; the work is making it prominent, not new computation.

2. **Per-keyword engine coverage table.** For each tracked keyword, show which configured engines cite the domain in the latest run. Shape: `keyword | gemini ✓ | claude ✗ | openai ✗ | perplexity ✓ | coverage 2/4`. Drives the "which engine needs work" decision.

3. **Competitor gap list.** Keywords where the project is *not* cited but at least one configured competitor *is*. Derived from `query_snapshots.citedDomains` ∩ `projects.competitors` for not-cited rows. Most actionable surface: each row maps to a content/SEO task.

### What's already in place

- `query_snapshots` already stores `citationState`, `citedDomains`, `competitorOverlap`, `provider`. No schema change needed.
- Project-level "cited by N" is computed in [`packages/intelligence/src/health.ts`](../packages/intelligence/src/health.ts) and exposed as `HealthSnapshotDto.providerBreakdown` via `/projects/:name/health/latest` — but only as a project aggregate, buried inside the overview composite.
- [`apps/web/src/components/project/CitationTimeline.tsx`](../apps/web/src/components/project/CitationTimeline.tsx) already renders per-keyword cited/not-cited dots over time.

### What's missing

- A per-keyword "engine coverage" rollup. Today an agent can list all snapshots and compute it client-side, but the "single-call reads" principle says it should be one API call.
- A competitor-gap query path. The data exists in `competitorOverlap` JSON, but no endpoint aggregates "for these queries, competitors are cited but we aren't".
- Prominent UI placement. Project-level providerBreakdown is buried; per-keyword and competitor-gap views don't exist at all.

### Implementation plan

| Layer | File(s) | Change |
|-------|---------|--------|
| Contracts | `packages/contracts/src/citations.ts` (new) | `CitationCoverageRow`, `CompetitorGapRow`, `CitationVisibilityResponse` DTOs + Zod schemas |
| API | `packages/api-routes/src/citations.ts` (new) | `GET /projects/:name/citations/visibility` — single endpoint returning `{ summary, byKeyword[], competitorGaps[] }`, computed from latest snapshot per (keyword × provider) |
| CLI | `packages/canonry/src/commands/citations.ts` (new) + dispatch in `packages/canonry/src/cli-commands/` | `canonry citations visibility <project> [--format json]` |
| Client | `packages/canonry/src/client.ts` | Add `getCitationVisibility(projectName)` returning the typed DTO |
| MCP | `packages/canonry/src/mcp/tool-registry.ts` | Register `canonry_citations_visibility` under the `monitoring` toolkit |
| UI | `apps/web/src/components/project/CitationVisibilitySection.tsx` (new) | Three-block layout, inserted into the project page near `TrafficSection` |
| Tests | `packages/contracts/test/citations.test.ts`, `packages/api-routes/test/citations-route.test.ts`, `packages/canonry/test/cli-citations.test.ts` | Contract round-trip; API happy path + competitor overlap edge cases; CLI output assertions |

Estimated size: ~600 LOC across the layers. No DB migrations.

### Open question deferred to 2C

Whether (and how) to correlate per-keyword coverage with per-page Direct traffic from #374. Plan: ship 2B headlines first, then re-scope 2C against a real citation-visibility view rather than against speculation.

## Step 2C / 2D — Deferred until 2B lands

**2C (citation-to-traffic gap):** for each citation event, is there measurable traffic? At small volume the gap *is* the insight: "8 Gemini citations in 30 days → 0 detectable AI clicks" tells the user their citations aren't converting. Requires joining `query_snapshots` (citation events) to `ga_traffic_snapshots` (per-day traffic to the cited domain's pages) — but only at domain level until URL retention ships.

**2D (GSC ⨝ AI citation overlap):** queries the site ranks organically for (in `gsc_search_data`) vs queries Canonry tracks for AI citation (in `query_snapshots` + keywords). Divergence is strategically meaningful: "you rank #3 organically for X but Gemini doesn't cite you for the same query."

Re-scope after 2B is in production. The 2B view will likely shape the column layout and table semantics for 2C and 2D so they feel like extensions, not bolt-ons.

## What was considered and rejected

- **T0-windowed lift attribution** (Model A in conversation). Anchored on `query_snapshots.created_at` as the citation start time. Rejected: that timestamp is sweep cadence, not citation start. Would fit noise to noise.
- **Custom JS embed on customer sites for client-side AI detection.** Rejected: high friction, doesn't catch the bot ingestion layer (ChatGPT-User, PerplexityBot don't run JS), better signal lives server-side anyway.
- **BigQuery Export as a v1 prerequisite.** Demoted to v1.1+ optional; see finding 5 above.
- **Provider URL retention as a prerequisite for Step 1.** Deferred to a separate change — useful but not load-bearing for path normalization or for the 2A panel. Will become important when 2C tightens to per-URL precision.
- **Cloudflare logs / Tier 2+ adapters.** Not in scope until a customer asks. Documented in the original architecture brief as a future tier.

## Open questions for future sessions

1. **Sweep cadence per project.** `node-cron` and a `schedules` table exist but the cadences currently configured weren't audited. This sets the error bar on `first_observed` if/when 2C tightens. Worth a `SELECT cron, kind, project_id FROM schedules WHERE kind = 'answer-visibility'` survey.
2. **Citation persistence distribution.** For each (provider, query, domain) tuple, how many consecutive sweeps does the citation persist? Determines whether presence-window models get stable signal. Distribution analysis on existing `query_snapshots` would answer this in <100 LOC.
3. **Higher-volume validation site.** The projects currently available for testing are below the volume floor for any traffic-side AI attribution model. 2C will produce empty/flat outputs on these. Either onboard a site with ≥3,000 sessions/month, or accept that 2C ships without empirical validation against real signal. (2B is volume-independent and does not have this problem.)
4. **Bing Webmaster integration overlap.** [`packages/integration-bing`](../packages/integration-bing) is wired but the data it persists wasn't audited. If it captures Bing Chat / Copilot citation data, that's a fifth provider to fold into the 2B coverage view.
5. **URL retention for non-Gemini providers.** Deferred change still pending. Becomes load-bearing for 2C when we want per-URL precision (vs domain-level only).

## Live data appendix (anonymized, ~30-day window in late April 2026)

Snapshot of the diagnostic run for reference. Re-running the equivalent query later will tell us if signal has emerged. Numbers below are from the small B2B test project.

```
GA traffic summary
  total_sessions:          ~123
  total_organic_sessions:  ~13
  total_users:             ~84

Daily session counts ranged 1–12 sessions/day, no day exceeded 12.

Top landing pages (non-organic, after fbclid strip):
  /                   ~75 sessions  (~60% of all traffic)
  (not set)            ~7
  /about/              ~6
  /<service-page>/     ~4
  ?fbclid variants     ~9 total (collapsed by normalization)
  /<region>/           ~2
  Everything else      <2 each

Citations:
  gemini      8 cited / ~190 sweeps (4.2% citation rate)
  claude      0 cited / ~138 sweeps
  openai      0 cited / ~138 sweeps
  perplexity  0 cited / ~138 sweeps
```

This appendix is now baseline. After 2B lands, the citation-visibility view should make the gemini-only coverage immediately obvious to the user without an ad-hoc SQL run.

Diagnostic methodology: ad-hoc Node scripts using `better-sqlite3` against the canonry SQLite database to inspect `ga_traffic_snapshots`, `ga_ai_referrals`, `query_snapshots`, and the raw provider responses stored on `query_snapshots.raw_response`. The scripts can be reconstructed from the schema; they're not committed.

## Files referenced

### Step 1 + 2A (shipped)

- [`packages/contracts/src/url-normalize.ts`](../packages/contracts/src/url-normalize.ts) — `normalizeUrlPath()`
- [`packages/db/src/schema.ts`](../packages/db/src/schema.ts) — `ga_traffic_snapshots` (`landing_page_normalized`, `direct_sessions` columns)
- [`packages/db/src/migrate.ts`](../packages/db/src/migrate.ts) — `MIGRATIONS` array (Step 1 schema + index, Step 2A direct_sessions column)
- [`packages/integration-google-analytics/src/ga4-client.ts`](../packages/integration-google-analytics/src/ga4-client.ts) — `fetchTrafficByLandingPage` (line 272), `fetchAiReferrals` (line 487)
- [`packages/api-routes/src/ga.ts`](../packages/api-routes/src/ga.ts) — sync, traffic read (line 534), attribution-trend
- [`packages/canonry/src/commands/backfill.ts`](../packages/canonry/src/commands/backfill.ts) — `backfill normalized-paths` (idempotent)
- [`apps/web/src/components/project/TrafficSection.tsx`](../apps/web/src/components/project/TrafficSection.tsx) — Channel breakdown (line 535)

### Step 2B (next)

- [`packages/db/src/schema.ts`](../packages/db/src/schema.ts) — `query_snapshots` (already has `citationState`, `citedDomains`, `competitorOverlap`, `provider`)
- [`packages/intelligence/src/health.ts`](../packages/intelligence/src/health.ts) — existing `computeHealth()`; reuse the per-provider rollup logic
- [`packages/api-routes/src/intelligence.ts`](../packages/api-routes/src/intelligence.ts) — existing `/health/latest` endpoint; new endpoint sits next to it
- [`apps/web/src/components/project/CitationTimeline.tsx`](../apps/web/src/components/project/CitationTimeline.tsx) — adjacent component; new section sits near it

### Provider URL retention (deferred)

- [`packages/provider-gemini/src/normalize.ts`](../packages/provider-gemini/src/normalize.ts) — opaque redirect handling (line 298–338)
- [`packages/provider-claude/src/normalize.ts`](../packages/provider-claude/src/normalize.ts), [`packages/provider-openai/src/normalize.ts`](../packages/provider-openai/src/normalize.ts), [`packages/provider-perplexity/src/normalize.ts`](../packages/provider-perplexity/src/normalize.ts) — sibling normalizers
- [`packages/contracts/src/run.ts`](../packages/contracts/src/run.ts) — `groundingSourceSchema` (`{ uri, title }`)
