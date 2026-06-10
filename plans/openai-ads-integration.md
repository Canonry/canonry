# OpenAI Advertiser API (ChatGPT Ads) Integration Plan

Status: design plan, phased; Phase 1 ships standalone
Last updated: 2026-06-10

## Context

ChatGPT now serves ads in the consumer UI (Free and Go tiers, US first with more
countries rolling out). Advertisers manage campaigns through OpenAI's Advertiser
API (`https://api.ads.openai.com/v1`, bearer auth, key minted in Ads Manager and
scoped to a single ad account).

One structural fact drives the strategic fit: ads appear only in the ChatGPT
consumer UI and never in API responses. Canonry's answer-visibility sweeps will
never observe them. The Advertiser API is the only window into the paid layer of
a surface Canonry already monitors organically. This pairs organic answer-engine
visibility with paid placement data, the same way SEO suites pair organic
rankings with PPC.

Nothing in `docs/roadmap.md` covers ads today. This is a new lane, complementary
to first-party console ingestion (GSC gen-AI, Bing AI Performance).

The ad group's targeting primitive is `context_hints`: free-text descriptions of
the conversations where an ad is relevant, not exact-match keywords. This is the
join key for Phase 3 paid-vs-organic overlap analysis against tracked queries.

## Goals

1. Ingest paid performance (impressions, clicks, spend, conversions) per
   campaign, ad group, and ad into daily rollups, on a schedule.
2. Manage campaigns from Canonry: pause/resume, budget and bid changes, and
   `context_hints` updates, through API, CLI, and dashboard.
3. Answer the overlap questions nobody else can: where are we organically cited
   AND still paying (spend-efficiency candidates), and where did we lose
   citation with no paid backstop (defensive-spend candidates).
4. Keep the integration invisible until connected. Most projects will not be
   eligible or enrolled; doctor checks and dashboards must skip cleanly.

## Non-Goals

- No campaign or ad creation in the first management phase. Creation requires
  creative file upload and review-state handling; it lands as a follow-up once
  lifecycle management is proven (see Phase 2b).
- No automated spend decisions by Aero. Write tools are excluded from the agent
  by default; a human triggers every mutation in v1.
- No attempt to estimate ad exposure from sweeps. Ads are not observable
  outside the consumer UI; the Insights API is the only performance source.
- No multi-account agency management in v1. One connection per project covers
  the current single-key reality; agencies hold multiple keys across projects.

## Canonry Boundaries

Per `AGENTS.md`:

- API and CLI first; the dashboard consumes API data only.
- MCP tools are adapters over public API client methods.
- Aero receives tools through the MCP-to-agent adapter once the registry is
  updated; write tools additionally gated (see Phase 2).
- The API key lives in `~/.canonry/config.yaml`, never in the database.
- Every new table or column in `schema.ts` has a matching migration in
  `migrate.ts` (next version: 76).
- New endpoints flow server route → `openapi.ts` operation → schema registry →
  SDK regen (`pnpm --filter @ainyc/canonry-api-client gen`) → CLI/MCP/SPA
  consumers; the `codegen-drift` CI job enforces it.

## Upstream API Summary

- Base URL `https://api.ads.openai.com/v1`; `Authorization: Bearer <key>`; key
  is scoped to one ad account.
- Resources: campaigns → ad groups → ads, plus creative upload and ad account.
- Insights: `GET /ad_account/insights`, `/campaigns/{id}/insights`,
  `/ad_groups/{id}/insights`, `/ads/{id}/insights`. Metrics: impressions,
  clicks, spend, conversions, ctr, cpc, cpm. Daily or aggregate granularity,
  cursor pagination, filter/fields/sort parameters.
- Money is integer micros (`lifetime_spend_limit_micros`, `max_bid_micros`).
- Ad groups carry `context_hints`, geotargeting, and conversion tracking.
- Rate limit ~600 req/min per endpoint: generous for daily rollup syncs.
- No sandbox environment. End-to-end validation needs a real, verified US
  business ads account.

## Vocabulary

Paid metrics must never reuse organic vocabulary. `mentioned`/`cited` describe
answer-text and source-list presence; ad delivery is `paid` / `sponsored`
(e.g. `paid-impressions`, `sponsored placement`). Add a lint-banned-literal
block in `eslint.config.js` scoped to the ads command/route files, mirroring
the existing AEO vocabulary rule, and document the terms in the `AGENTS.md`
vocabulary section.

## Data Model

Credentials in `~/.canonry/config.yaml` under an `openaiAds` section (API key
per connection). The database stores metadata and synced data only.

### `ads_connections`

Ads accounts are not domain-bound, so the connection keys on `project_id`
(model: `ga_connections`), not `(domain, connectionType)`.

- `id`
- `project_id` (unique; one connection per project)
- `ad_account_id`
- `display_name`
- `status`: `connected` | `error`
- `last_synced_at`
- `created_at` / `updated_at`

### `ads_campaigns`, `ads_ad_groups`, `ads_ads`

Entity snapshots refreshed on every sync, so dashboards, overlap analysis, and
management commands can list entities without live API calls.

- `id` (upstream id), `project_id`, `name`, `status`
- campaigns: `lifetime_spend_limit_micros`
- ad groups: `campaign_id`, `max_bid_micros`, `context_hints` (JSON),
  geotargeting (JSON)
- ads: `ad_group_id`, creative metadata
- `sync_run_id` (nullable FK to `runs`, `ON DELETE SET NULL`)

### `ads_insights_daily`

Model: `gbp_daily_metrics`. Date is `TEXT` `YYYY-MM-DD`; counts and micros are
`INTEGER`; derived ratios (ctr, cpc, cpm) are computed at read time, not
stored.

- `id`, `project_id`
- `date`
- `level`: `account` | `campaign` | `ad_group` | `ad`
- `entity_id` (upstream id; account id at account level)
- `impressions`, `clicks`, `conversions` (INTEGER)
- `spend_micros` (INTEGER)
- `sync_run_id`
- Unique index on `(project_id, level, entity_id, date)`; sync upserts via
  `ON CONFLICT DO UPDATE` so re-runs are safe.

### Contracts

- New DTOs in `packages/contracts/src/ads.ts` (connection status, campaign
  list, insights series, summary).
- Add `formatMicros` / `formatCurrency` helpers to
  `packages/contracts/src/formatting.ts` (none exist today).

## Phase 1: Read-Only Ingestion

Ships standalone and is useful on its own.

**New package `packages/integration-openai-ads/`.** Thin typed client. Auth
template: `integration-google`'s `gscFetch` pattern (bearer header, generic
JSON fetch with timeout, custom `OpenAiAdsApiError` with status mapping for
401/403/429). Structure template: `integration-bing` (~600 LOC including
tests). New ground: cursor pagination (no existing integration paginates by
cursor); implement a `paginate()` helper that follows the cursor until
exhausted and cap pages defensively.

**Run kind `ads-sync`.** Added to `runKindSchema`
(`packages/contracts/src/run.ts`) and `schedulableRunKindSchema`
(`packages/contracts/src/schedule.ts`). Wire `onAdsSyncRequested` through
`scheduler.ts` and `server.ts` exactly like `gbp-sync`; sync worker
`packages/canonry/src/ads-sync.ts` refreshes entity snapshots then pulls daily
insights for a trailing window (default 28 days) and upserts rollups.
`data-refresh` includes `ads-sync` when a connection exists. Schedule via
`canonry schedule set <project> --kind ads-sync --preset daily`.

**API routes** in `packages/api-routes/src/ads.ts` under
`/api/v1/projects/{name}/ads/`:

- `POST /ads/connect` (key validated against the upstream account, stored in
  config.yaml; metadata row written; audit-logged)
- `DELETE /ads/connection` (disconnect; audit-logged)
- `GET /ads/status`
- `POST /ads/sync`
- `GET /ads/campaigns` (snapshot list with ad groups and hints)
- `GET /ads/insights` (level + entity + date-range filters)
- `GET /ads/summary` (spend/clicks/conversions totals with deltas)

All registered in `openapi.ts` + schema registry, SDK regenerated. MCP
classification: reads `included`; `connect`/`disconnect` `deferred`
(credential-bearing, same as settings mutations).

**CLI** `canonry ads connect|status|sync|campaigns|insights|summary` with
`--format json`, following the `connect|status|sync` integration pattern.

**MCP.** Read tools in the registry (likely a new `ads` toolkit tier, lazily
loaded like `gsc`/`ga`).

**Doctor.** `ads.auth.connection` and `ads.data.recent-sync`, both `skipped`
when no connection row exists (model: GBP/Places checks).

## Phase 2: Management Writes

The reason this lane exists for operators: manage ChatGPT ads from Canonry.

**2a, lifecycle management (in scope now):**

- Pause/resume campaigns, ad groups, ads.
- Update campaign `lifetime_spend_limit_micros`, ad group `max_bid_micros`.
- Update ad group `context_hints` (the lever that applies query-consolidation
  recommendations) and geotargeting.

Routes: `POST .../ads/campaigns/{id}/pause|resume` (same for ad groups and
ads), `PATCH .../ads/campaigns/{id}`, `PATCH .../ads/ad-groups/{id}`. After a
successful upstream write, re-fetch the entity and update the snapshot row so
local state never lies.

**Safety rails (all mandatory):**

- New `ads.write` API-key scope; routes reject keys without it (precedent:
  `keys.write`).
- Every mutation writes `audit_log` with a before/after diff
  (`actor`, `action: 'ads.campaign-paused'` etc., `entityType`, `entityId`).
- MCP write tools registered with `access: 'write'` and added to
  `AERO_EXCLUDED_MCP_TOOLS`. An agent must never move money by default;
  enabling Aero for ads writes is a deliberate future decision with its own
  review.
- OpenAPI classification: write ops `deferred` for MCP in v1 (CLI, API, and
  dashboard are the management surfaces).

**CLI:** `canonry ads pause|resume <campaign|ad-group|ad> <id>`,
`canonry ads set-budget <campaign-id> --limit <amount>`,
`canonry ads set-bid <ad-group-id> --max <amount>`,
`canonry ads set-hints <ad-group-id> --hints <text>` (amounts accepted in
currency units, converted to micros at the edge).

**2b, creation flows (deferred follow-up):** campaign/ad group/ad creation and
creative upload. Needs asset handling and upstream review-state polling;
scoped only after 2a is proven against a real account.

## Phase 3: Paid × Organic Overlap

The differentiated layer; smaller in code than Phase 1, highest value.

- Join ad group `context_hints` against tracked queries (semantic/fuzzy match
  with a confidence score; degrade gracefully to account-level paid-vs-organic
  trendlines when mapping confidence is low).
- New intelligence insights generated post-run in the existing
  `RunCoordinator` → intelligence path:
  - cited-and-paying: queries with sustained organic citation share where a
    matched ad group is active (spend-efficiency candidates),
  - uncited-and-unpaid: queries that lost citations with no matched active ad
    group (defensive-spend candidates).
  Citation state must come from rolling multi-sweep windows, not a single
  sweep; single-run citation presence is too volatile to gate spend advice.
- Report section: paid summary + overlap. SPA (`ReportPage.tsx`) and HTML
  renderer (`report-renderer.ts`) updated together per the report-parity rule,
  with renderer tests.
- Aero playbook `skills/aero/references/ads-optimization.md`: how to read the
  overlap insights and what to recommend (recommendations only; no writes).

## Testing

- Client fixtures must mirror real API responses captured from live curl
  output, never invented from our type definitions. Record sanitized fixtures
  for every consumed endpoint, including a cursor-paginated insights response
  and 401/403/429 errors.
- e2e in `packages/api-routes/test/`: route coverage in the OpenAPI contract
  test, probe-exclusion where applicable, doctor checks (connected, stale,
  not-connected/skip), write-scope rejection, audit-log assertions on every
  mutation.
- `packages/canonry/test/commands/`: CLI surface including `--format json` and
  micros/currency edge conversion.

## Versioning and PR Breakdown

Minor bumps per `AGENTS.md` (sync root and `packages/canonry` package.json) on
feature PRs over 100 lines.

1. This plan doc + roadmap lane entry (docs-only, no bump).
2. `integration-openai-ads` package: client + types + fixture tests.
3. Phase 1 wiring: migration 76 (connection, snapshots, rollups), `ads-sync`
   run kind + scheduler, routes + spec + SDK regen, CLI, doctor, MCP reads,
   vocabulary lint, `formatMicros`. Minor bump. Split into two PRs if review
   size demands (sync engine, then surfaces).
4. Phase 2a management writes: scope, audit, routes, CLI, Aero exclusion.
   Minor bump.
5. Phase 3 overlap: matcher, insights, report section (SPA + HTML), Aero
   playbook. Minor bump.

## Risks and Open Questions

- **No sandbox.** Mocked fixtures cover unit and route tests, but end-to-end
  validation needs a real, verified US business ads account (the GBP test
  account equivalent). Decide whose account before PR 3 merges.
- **Eligibility ceiling.** Four countries today and restricted categories
  (finance/health/legal). Acceptable: the integration is opt-in per project
  and invisible until connected.
- **`context_hints` expressiveness.** Phase 3 mapping fidelity depends on how
  expressive hints turn out to be in practice; the overlap analysis ships with
  the confidence-based degradation path from day one.
- **Currency.** Insights spend is micros; confirm the account currency field
  and surface it in `formatCurrency` rather than assuming USD.
- **Multi-account agencies** need multiple keys (OpenAI: "contact the
  advertiser team"). One connection per project covers this naturally; revisit
  if a project ever needs two accounts.
