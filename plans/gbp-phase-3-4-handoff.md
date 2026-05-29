# Google Business Profile — Phase 3 & 4 Handoff

Status: handoff plan. Phases 1–2b shipped in PR #508 (v4.58.0).
Last updated: 2026-05-29

This is a pick-up-and-go plan for the next owner of the Google Business Profile
(GBP) integration. Phases 1–2b are merged and live; everything below is **not yet
built**. Read this top to bottom once, then work a phase at a time.

## What already exists (Phases 1–2b)

The data plane is complete and exposed on all three surfaces (API · CLI · MCP),
and Aero already reads it through the MCP-to-agent adapter.

- **Auth + discovery**: OAuth (reuses the Google client; `gbp` connection type),
  `gbp accounts`, `gbp locations discover --account … [--switch-account]`,
  per-location select/deselect. Account selection is **per project** (one project
  tracks one account's locations).
- **Sync** (`gbp sync`, run kind `gbp-sync`): per selected location it pulls daily
  metrics, search-keyword impressions, place-action CTAs, and the lodging resource.
- **Reads**: `gbp metrics | keywords | place-actions | lodging | summary`. The
  composite `summary` scopes to selected locations and does all the math
  server-side (`packages/api-routes/src/gbp-summary.ts`, exhaustively unit-tested).
- **Deliberately out of scope** (do not re-add): **Reviews** (v4 API is
  Google-gated per project; can't self-enable) and **Q&A** (API retired, HTTP 501).

### Key files to know

| Concern | File |
|---|---|
| Typed API clients (accounts/locations/performance/place-actions/lodging) | `packages/integration-google-business-profile/src/` |
| Sync worker | `packages/canonry/src/gbp-sync.ts` (`executeGbpSync`) |
| Routes (GSC + GBP share this file) | `packages/api-routes/src/google.ts` |
| Pure summary math | `packages/api-routes/src/gbp-summary.ts` |
| DTOs + request schemas | `packages/contracts/src/gbp.ts` |
| Tables (`gbp_locations`, `gbp_daily_metrics`, `gbp_keyword_impressions`, `gbp_place_actions`, `gbp_lodging_snapshots`) | `packages/db/src/schema.ts` (migrations v67–v69) |
| MCP tools (`canonry_gbp_*`) | `packages/canonry/src/mcp/tool-registry.ts` |
| Operator playbook | `skills/canonry/references/google-business-profile.md` |

## Canonry boundaries (these must hold in every phase)

- **API and CLI first.** Every capability ships as an API endpoint + CLI command
  before (or with) any UI.
- **The dashboard consumes API data only.** No UI-only calculations — derived
  numbers live in the API response (`GbpSummaryDto` already does this).
- **MCP tools are adapters over the public API client.** Aero picks up new tools
  automatically once they're in the MCP registry.
- **Credentials stay in `~/.canonry/config.yaml`**, never the DB.
- **Schema change → matching migration** in `packages/db/src/migrate.ts`.
- **Every calculation gets logical tests** (assert the math, cover zero/empty/
  rounding/divide-by-zero), per the root AGENTS.md "Calculation Testing" rule.
- **Report parity**: if a GBP block ever lands in the downloadable report, the SPA
  (`ReportPage.tsx`) and HTML (`report-renderer.ts`) must move together.

---

## Phase 3 — Web UI (`GbpSection.tsx`)

**Goal.** A Google Business Profile section on the project page that renders the
data the API already returns. No new backend work — this is pure consumption.

**Pattern to follow.** Copy the shape of `apps/web/src/components/project/GscSection.tsx`
(the closest analog — an integration section with connect state, sync trigger,
and stored-data reads). `GaSection` is a second reference.

**Files**
- Create `apps/web/src/components/project/GbpSection.tsx`.
- Wire it into `apps/web/src/pages/ProjectPage.tsx` (import + conditional render,
  the way `GscSection` is mounted — gated on a GBP connection existing).
- Add `fetchGbp*` wrappers to `apps/web/src/api.ts` **only if** a composite read is
  needed; otherwise call the generated SDK options directly.

**Data it consumes** (all generated already — confirm names in
`packages/api-client-generated/src/generated/@tanstack/react-query.gen.ts`):
- `getApiV1ProjectsByNameGbpSummaryOptions` — the headline scorecard (`GbpSummaryDto`).
- `…GbpLocationsOptions`, `…GbpAccountsOptions` — selection + account state.
- `…GbpMetricsOptions`, `…GbpKeywordsOptions`, `…GbpPlaceActionsOptions`, `…GbpLodgingOptions` — detail tables.
- Mutations: `postApiV1ProjectsByNameGbpSync`, `…GbpLocationsDiscover`,
  `putApiV1ProjectsByNameGbpLocationsByLocationNameSelection`, `deleteApiV1ProjectsByNameGbpConnection`.

**Suggested layout** (render only — every number is already computed in `summary`):
- Header with connection state + account name + a "Sync" button.
- Score gauges / tiles for the `summary.performance` totals and 7-day deltas
  (`deltaPct` is `null` when there's no prior window — render as "—", not 0%).
- A data **table** (not a card grid) for keywords (lead with exact counts, show
  `<N` for thresholded, surface `thresholdedPct` as the fidelity caption).
- A locations table with the selection toggle.
- Place-action CTA presence (reservation / booking / direct-merchant flags) and,
  for hotels, lodging completeness (`emptyLodgingCount` is the AEO-gap signal).

**Design-system constraints** (root `CLAUDE.md` + `apps/web/AGENTS.md`):
- Charts: Recharts **only** via `components/shared/ChartPrimitives`. Custom SVG is
  fine for gauges/sparklines.
- Tables over card grids for any list of 3+ items; `ToneBadge` for all status.
- No raw `fetch()` — reads flow through the generated SDK via `heyClient`.
- `bg-zinc-950` surfaces, emerald/amber/rose/zinc tones, eyebrow labels.

**Acceptance**: a connected project shows live GBP data; everything visible has a
CLI equivalent already (it does); no business logic in the component.

---

## Phase 4 — Operationalize

Three independent workstreams. They can land in any order.

### 4a. Scheduling — make `gbp-sync` a schedulable kind

Today schedules support `answer-visibility` and `traffic-sync` (one row per
`(project, kind)`). Add `gbp-sync` by following exactly how `traffic-sync` was wired.

- `packages/contracts/src/schedule.ts` — add `'gbp-sync'` to
  `schedulableRunKindSchema`. The DTO's optional `sourceId` stays `null` for GBP.
- `packages/canonry/src/scheduler.ts` — add `onGbpSyncRequested?(runId, projectId)`
  to `SchedulerCallbacks`, and a dispatch branch in `triggerRun()` mirroring the
  `traffic-sync` branch (but no `sourceId` requirement).
- `packages/canonry/src/server.ts` — register the `onGbpSyncRequested` callback
  (it should fire the same path the manual `POST /gbp/sync` route uses;
  `onGbpSyncRequested` already exists as an `ApiRoutesOptions` hook for the manual
  route — reuse that worker entry point).
- `packages/api-routes/src/schedules.ts` — the route is mostly kind-agnostic;
  ensure the "`sourceId` only valid for traffic-sync" guard doesn't reject GBP.
- `packages/canonry/src/cli-commands/schedule.ts` — add `gbp-sync` to the
  `--kind` usage strings (command impl is already generic).
- Tests: extend the scheduler + schedules-route tests with a `gbp-sync` case.

No schema/migration change — the `schedules` table is already generic.

### 4b. Doctor checks — `gbp.auth.*`

Mirror the GA/GSC auth checks so `canonry doctor --project <p> --check 'gbp.auth.*'`
works.

- Add checks in `packages/api-routes/src/doctor/checks/` (a new `gbp-auth.ts`, or
  extend `google-auth.ts`). Follow the `CheckDefinition` shape used by
  `ga-auth.ts`: stable dotted `id`, `category: auth`, `scope: project`, an async
  `run(ctx)` returning `{ status, code, summary, remediation?, details? }`.
- Reach the connection via `ctx.googleConnectionStore.getConnection(domain, 'gbp')`
  and verify the token by calling `listAccounts(accessToken)` from the GBP
  integration package (catch `GbpApiError` → map 0-QPM/scope/permission to
  `warn`/`fail` codes; the route mapper `gbpErrorToAppError` in `google.ts` is a
  good reference for which reasons mean what).
- Suggested check set: `gbp.auth.connection` (creds present + token refreshes),
  `gbp.auth.scopes` (granted scope includes `business.manage`),
  `gbp.account.access` (the tracked account is still listable),
  and optionally `gbp.data.recent-sync` (a non-archived selected location synced
  in the last N days — warn/fail by age, mirroring `traffic.source.recent-data`).
- Register the new checks in `packages/api-routes/src/doctor/registry.ts`
  (`ALL_CHECKS`).
- Tests under `packages/api-routes/test/doctor-gbp-*` covering each `code` value.
- Document the new IDs in the root `AGENTS.md` "Doctor" table.

### 4c. Insights + Aero — analyze after a `gbp-sync` run

Today `RunCoordinator.onRunCompleted()` early-returns for probe runs and only runs
intelligence for `answer-visibility`. A `gbp-sync` run already reaches the Aero
wake-up path, but with **zero insights** because nothing analyzes GBP yet. Add the
analysis branch.

- **Pure analyzers** in `packages/intelligence/` (new `gbp-analyzer.ts`, or split
  by surface). Pure functions only: take GBP rows in, return typed `Insight[]` out,
  no DB access. Extend the `InsightType` union in `packages/intelligence/src/types.ts`
  with GBP types.
- **`packages/canonry/src/intelligence-service.ts`** — add a method
  (`analyzeAndPersistGbp(runId, projectId)`) that reads the four GBP tables
  (scoped to selected locations, like the summary route does) and persists via the
  existing insight/health persistence path.
- **`packages/canonry/src/run-coordinator.ts`** — add an
  `else if (kind === RunKinds['gbp-sync'])` branch alongside the existing
  `answer-visibility` branch, calling `analyzeAndPersistGbp`. The notifier
  (`insight.critical` / `insight.high`) and the Aero follow-up already fire for any
  non-probe run, so once insights exist they flow out with no extra wiring.
- **Candidate insights** (each must be a tested pure function):
  - Lodging profile empty / sparse (`populatedGroupCount === 0`) — "AI engines have
    no structured amenity data to cite."
  - No direct-merchant booking CTA, only aggregator links
    (`hasDirectMerchantCta === false` with place actions present).
  - Search-keyword impressions for a head term dropped vs the prior synced window.
  - A headline daily metric (e.g. `BUSINESS_DIRECTION_REQUESTS`) fell sharply
    week-over-week.
- Tests in `packages/intelligence/test/` with fixture rows; assert exact
  severities and that empty/zero inputs produce no spurious insights.

---

## Phase 5 (noted, not planned here) — gated writes

Out of scope for this handoff, but the natural end state: review replies, local
posts/offers, and lodging-attribute edits. These are **write** operations behind
the `business.manage` scope and Google's 10-edits/min cap, and reviews remain
access-gated. Treat as a separate design once Phases 3–4 land. ADR-0009
(publish boundary) is the relevant precedent for an action/outcome ledger.

## Decisions left for the next owner

- **Phase 3 placement**: standalone "Local" section vs a tab inside the Google
  workspace area of `ProjectPage`. GSC/GA precedent leans toward a sibling section.
- **Insight dismissal key for multi-location projects**: the existing key is
  `query:provider:type`; GBP insights are location-scoped, so consider
  `location:type` to avoid cross-location collisions.
- **Metric range-replace semantics** (known, intentional): a sync replaces a
  location's whole stored metric history with the fetched window, so the store
  mirrors the last sync rather than accumulating. If Phase 4c insights want
  longer trend history, switch the worker to upsert-accumulate first — that's a
  deliberate semantics change, not a bug fix.
