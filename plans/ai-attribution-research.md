# AI Traffic Attribution — Research & Plan

## Status

Research complete; **Step 1 (data hygiene / path normalization) is the active deliverable**. Step 2 (better AI traffic capture using existing integrations) is designed at the option level here but not yet broken into commits — a separate design pass is required before building it. This doc preserves the reasoning behind both so a future session picks up cold.

Last updated: 2026-04-29.

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

## The two-step plan

### Step 1 — Data hygiene (active)

URL/path normalization across the GA layer. Specs in detail above the conversation; summary:

- New shared util `packages/contracts/src/url-normalize.ts` (pure function + golden-file tests)
- `landing_page_normalized TEXT` column on `ga_traffic_snapshots`
- New index `(project_id, date, landing_page_normalized)`
- Read-side `COALESCE(landing_page_normalized, landing_page)` so dashboards never enter a broken state during migration
- `canonry backfill normalized-paths` CLI command (idempotent)
- Conservative strip-list: `fbclid, gclid, msclkid, ttclid, li_fat_id, igshid, yclid, dclid, gbraid, wbraid, mc_cid, mc_eid, _ga, _gl, gtm_latency, gtm_debug, utm_*`
- Trailing slash collapsed (root `/` excepted)
- `/index.html`, `/index.php` collapse to `/`
- Case preserved
- `(not set)` normalized to NULL, surfaced in UI as `(unknown)` (not silently filtered)

Visible win: per-page tables stop being polluted (the test project goes from ~17 fragmented homepage rows to one). Total session counts unchanged.

Foundation laid: stable URL identity for everything downstream including the deferred citation URL retention change.

### Step 2 — Better AI traffic capture (next, separate design)

**Constraint**: only existing integrations. No BQ Export, no Cloudflare, no server-side log ingestion. Squeeze more signal out of GA4 Reports + GSC + `query_snapshots` + Bing Webmaster.

Four candidate scopes, in rough order of leverage:

**A. Replace the broken "Attributable AI visits" panel with an honest channel breakdown.** Today it shows 0/0%/0 on small projects, which a user reads as a measurement when it's really "we have nothing to show". Replace with a complete decomposition: organic / social / direct-to-homepage / direct-to-deep-pages / known-AI-referrals. Requires extending `fetchTrafficByLandingPage()` ([`packages/integration-google-analytics/src/ga4-client.ts:272`](../packages/integration-google-analytics/src/ga4-client.ts)) to fetch per-page Direct sessions. ~30 LOC GA client + ~150 LOC UI changes in [`apps/web/src/components/project/TrafficSection.tsx`](../apps/web/src/components/project/TrafficSection.tsx).

**B. Citation visibility as the headline AI metric.** Works at any volume; doesn't depend on GA at all. "Cited by N of 4 engines for these queries" plus the queries where competitors are cited but this site isn't. Most of the data already exists in `query_snapshots` and `intelligence-service.ts` analyses — needs surfacing more prominently.

**C. Citation-to-traffic gap.** For each citation event, is there measurable traffic? At small volume the gap itself is the insight: "8 Gemini citations in 30 days → 0 detectable AI clicks" tells the user their citations aren't converting, which is actionable. Requires joining `query_snapshots` (citation events) to `ga_traffic_snapshots` (per-day traffic to the cited domain's pages) — but only at domain level until the URL-retention change ships.

**D. GSC ⨝ AI citation overlap.** Queries the site ranks organically for (in `gsc_search_data`) vs queries Canonry tracks for AI citation (in `query_snapshots` + keywords). Divergence is strategically meaningful: "you rank #3 organically for X but Gemini doesn't cite you for the same query".

Step 2 has not been broken into commits. A separate design pass is needed once Step 1 lands.

## What was considered and rejected

- **T0-windowed lift attribution** (Model A in conversation). Anchored on `query_snapshots.created_at` as the citation start time. Rejected: that timestamp is sweep cadence, not citation start. Would fit noise to noise.
- **Custom JS embed on customer sites for client-side AI detection.** Rejected: high friction, doesn't catch the bot ingestion layer (ChatGPT-User, PerplexityBot don't run JS), better signal lives server-side anyway.
- **BigQuery Export as a v1 prerequisite.** Demoted to v1.1+ optional; see finding 5 above.
- **Provider URL retention as a prerequisite for Step 1.** Deferred to a separate change — useful but not load-bearing for path normalization or for Step 2 candidate scopes A–D at their initial granularity. Will become important when scope C is tightened to per-URL precision.
- **Cloudflare logs / Tier 2+ adapters.** Not in scope until a customer asks. Documented in original architecture brief as a future tier.

## Open questions for future sessions

1. **Sweep cadence per project.** `node-cron` and a `schedules` table exist but the cadences currently configured weren't audited. This sets the error bar on `first_observed` if/when Step 2 scope C tightens. Worth a `SELECT cron, kind, project_id FROM schedules WHERE kind = 'answer-visibility'` survey.
2. **Citation persistence distribution.** For each (provider, query, domain) tuple, how many consecutive sweeps does the citation persist? Determines whether presence-window models (Step 2 future) get stable signal. Distribution analysis on existing `query_snapshots` would answer this in <100 LOC.
3. **Higher-volume validation site.** The projects currently available for testing are below the volume floor for any traffic-side AI attribution model. Step 2 scopes A and C will produce empty/flat outputs on these. Either onboard a site with ≥3,000 sessions/month, or accept that Step 2 ships without empirical validation against real signal.
4. **Bing Webmaster integration overlap.** [`packages/integration-bing`](../packages/integration-bing) is wired but the data it persists wasn't audited. If it captures Bing Chat / Copilot citation data, that's a fifth provider to fold into citation visibility (scope B).

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

Diagnostic methodology: ad-hoc Node scripts using `better-sqlite3` against the canonry SQLite database to inspect `ga_traffic_snapshots`, `ga_ai_referrals`, `query_snapshots`, and the raw provider responses stored on `query_snapshots.raw_response`. The scripts can be reconstructed from the schema; they're not committed.

## Files referenced

- [`packages/integration-google-analytics/src/ga4-client.ts`](../packages/integration-google-analytics/src/ga4-client.ts) — `fetchAiReferrals` (line 487), `fetchTrafficByLandingPage` (line 272)
- [`packages/api-routes/src/ga.ts`](../packages/api-routes/src/ga.ts) — sync endpoint (line 373), traffic read endpoint (line 529), attribution-trend (line 851)
- [`packages/db/src/schema.ts`](../packages/db/src/schema.ts) — `ga_traffic_snapshots`, `ga_ai_referrals`, `query_snapshots`
- [`packages/db/src/migrate.ts`](../packages/db/src/migrate.ts) — `MIGRATIONS` array (where Step 1 schema migration lands)
- [`packages/provider-gemini/src/normalize.ts`](../packages/provider-gemini/src/normalize.ts) — opaque redirect handling (line 298–338)
- [`packages/provider-claude/src/normalize.ts`](../packages/provider-claude/src/normalize.ts), [`packages/provider-openai/src/normalize.ts`](../packages/provider-openai/src/normalize.ts), [`packages/provider-perplexity/src/normalize.ts`](../packages/provider-perplexity/src/normalize.ts) — sibling normalizers, all currently domain-only
- [`apps/web/src/components/project/TrafficSection.tsx`](../apps/web/src/components/project/TrafficSection.tsx) — "Attributable AI visits" panel (line 535)
- [`packages/contracts/src/run.ts`](../packages/contracts/src/run.ts) — `groundingSourceSchema` (`{ uri, title }`)
