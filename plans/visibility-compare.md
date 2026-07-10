# Plan: `visibility-compare` — statistically honest month-over-month AEO

## Context / why

Report builders (and Aero) need to compare a project's AEO visibility month over
month. Canonry could compute one month's pooled stats (`visibility-stats`,
#764) but had no comparison primitive, so callers hand-rolled deltas — which
produced a "declined ~4x" claim that a statistician panel judged **not real**
(June rested on a single mention at K=2 sweeps; every confidence interval
overlapped May; the provider models changed version between months). Per the
platform's *No UI-only calculations* and *Calculation Testing* rules, the honest
comparison method belongs in the engine, not in each report script.

## Method (from the statistician panel)

- **Primary metric = share of voice** (brand vs competitor mentions in the SAME
  answers). It cancels engine drift: when a provider's model updates it names
  more/fewer brands overall, a factor shared by numerator and denominator of a
  ratio but not of an absolute rate. SoV carries the directional call; the
  mention/cited **rate** is context (`driftRobust: false`).
- **K-invariant pooling**: rates are the per-snapshot proportion pooled over the
  whole month (a mean of per-sweep rates). Two inflating estimators were
  explicitly **rejected**: the per-query "named in ANY sweep" rate (climbs with
  sweep count via `1-(1-p)^K`) and the per-query OR-over-providers rate (climbs
  with provider count). Both fabricate m/m moves.
- **Common basket**: only queries + providers present in BOTH months are
  compared, so query/provider churn can't leak in. Exclusions are surfaced.
- **Uncertainty**: every figure carries a Wilson 95% interval; `verdict` is
  `within-noise` when the two periods' intervals overlap (never call a move on a
  handful of mentions a decline), `moved` when disjoint, `insufficient-data`
  when a period has no denominator.
- **Drift awareness**: `modelChanges` flags providers whose configured model id
  differs between periods. A config change is visible; a **silent upstream
  version bump under an unchanged id is NOT** — `query_snapshots.model` stores
  the configured id, not the resolved upstream version.

## Surface

- `GET /projects/:name/visibility-compare?from=YYYY-MM&to=YYYY-MM`
- `cnry visibility-compare <proj> --from 2026-05 --to 2026-06 [--format json]`
- MCP `canonry_visibility_compare` (monitoring tier, read)
- Pure `computeVisibilityCompare` (`api-routes/src/visibility-compare.ts`) +
  `wilsonInterval` (`contracts/src/statistics.ts`); DTOs in `visibility-stats.ts`.

## Consistency with the dashboard hero

Verified: the overview hero's **Mention-share** uses the same `buildMentionShare`
this endpoint pools, so leading with SoV is consistent with what a user sees on
the dashboard (the hero uses the latest sweep, this pools the month). The hero's
**Mentioned/Cited** tiles are per-query/latest — a *different* metric — so this
endpoint reports mentions as a **count** (hero-compatible) and keeps the
per-snapshot rate as a clearly-labeled "level", never head-to-head with the tile.

## Deliberately out of scope (follow-ups)

1. **Persist the upstream response model** (`apiResponse.model` /
   `modelVersion`) into a queryable column so a SILENT version bump becomes
   detectable — today it lives only in the untokenized `raw_response` blob.
2. **Report/SPA integration** — a report renderer consuming this DTO (the DemandIQ
   m/m one-pager is the first consumer; kept as a separate report-parity PR).
3. **Rate-ratio confidence interval** — Katz's log-CI is undefined at the zero
   counts these months actually produce; the CI-overlap `verdict` carries the
   same signal and never degenerates, so v1 ships the point rate ratio only.
4. **Provider-mix reweighting** within the basket (equal-weight-per-provider) —
   the per-snapshot pool is used as the level; documented as a refinement if
   provider cell sizes become very unbalanced.
5. **Arbitrary ISO windows / CPI chaining** across basket changes — months only
   in v1.
6. **Operational, not code**: raise DemandIQ's sweep schedule to K>=5 so a
   `moved` verdict is ever reachable (`lowRunCount` flags when it isn't).

## Tests

`contracts/statistics.test.ts` (exact Wilson fixtures) ·
`api-routes/visibility-compare.test.ts` (basket, K-invariance, provider-union
rejection, SoV + cited-SoV with raw/subdomain competitor matching, verdict,
model drift, low-run flag) · `api-routes/visibility-compare-route.test.ts`
(probe exclusion, validation, month echo). The shared `probe-exclusion.test.ts`
seeds a single month and cannot exercise a two-month endpoint, so this route's
probe-exclusion invariant is asserted in its dedicated route test.
