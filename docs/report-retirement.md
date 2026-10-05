# Report retirement in Canonry 7

Canonry 7 removes the dedicated Report tab, HTML renderer, report bundle, and report-only scores.
The CLI, REST API, and MCP expose the underlying evidence through the reads below.
AI Visibility and Advanced Measurement retain their measurement contracts and query-class scopes.
The `report.*` Doctor checks retain their public IDs for monthly completeness, model continuity, source coverage, and referral-burst diagnostics.

## Removed surfaces

- `GET /api/v1/projects/:name/report`
- `GET /api/v1/projects/:name/report.html`
- `canonry report`
- `canonry_report`
- The report embed tab and `ProjectReportDto`

Old dashboard URLs at `/projects/:name/report` redirect to AI Visibility.
The removed API routes return HTTP 404.
Remove `report` from embed tab configuration. Server startup refuses enabled configurations that contain it, including mixed tab lists. Per-request overrides that select it are refused with a retirement error. The SPA also shows a retirement error for legacy injected embed configuration.

## Replacement reads

| Former Report evidence | REST API | CLI | MCP |
| --- | --- | --- | --- |
| Mention and citation coverage, trends, and scope breakdowns | `/projects/:name/visibility-report` | `canonry measurement-plan visibility` | `canonry_visibility_report` |
| Non-brand competitor evidence | `/projects/:name/analytics/competitors?queryClass=non-brand` | `canonry competitor landscape --query-class non-brand` | `canonry_competitor_landscape` with `queryClass: "non-brand"` |
| Cited domains and source categories | `/projects/:name/analytics/sources` | `canonry sources` | `canonry_analytics_sources` |
| Server traffic totals, operators, paths, and referring products | `/projects/:name/traffic/analytics` | `canonry traffic analytics` | `canonry_traffic_analytics` |
| Search Console totals and queries | `/projects/:name/google/gsc/performance/daily`, `/projects/:name/google/gsc/query-totals` | `canonry google performance-daily`, `canonry google query-totals` | `canonry_gsc_performance_daily`, `canonry_gsc_query_totals` |
| Analytics sessions and AI referrals | `/projects/:name/ga/traffic`, `/projects/:name/ga/ai-referral-daily` | `canonry ga traffic`, `canonry ga ai-referral-daily` | `canonry_ga_traffic`, `canonry_ga_ai_referral_daily` |
| Index coverage | `/projects/:name/google/gsc/coverage`, `/projects/:name/bing/coverage` | `canonry google coverage`, `canonry bing coverage` | `canonry_gsc_coverage`, `canonry_bing_coverage` |
| Content opportunities and insights | `/projects/:name/content/targets`, `/projects/:name/insights` | `canonry content targets`, `canonry insights` | `canonry_content_targets`, `canonry_insights_list` |
| Saved content-target dismissals | `GET`/`POST /projects/:name/content/dismissals`, `DELETE /projects/:name/content/dismissals/:targetRef` | `canonry content dismissals`, `canonry content dismiss`, `canonry content restore` | `canonry_content_dismissals`, `canonry_content_dismiss`, `canonry_content_restore` |

All REST paths above start with `/api/v1`.
Use the same project credentials and scope parameters as the corresponding evidence read.
Bing coverage is available through the `bing` MCP toolkit and retains its existing connection requirement.
Historical competitor landscapes need an explicit query class for percentages. Omitted class or `all` returns pooled counts with null shares; request branded evidence separately.
The former report-only citation scorecard, smoothing, composite landscapes, and recommendation copy are removed.
Agents can prepare reports from these stored measurements without a second metric calculation pipeline.

The former GSC fields `gsc.categoryBreakdown` (brand, lead-gen, industry, and other), `gsc.trackedButNoGsc`, and `gsc.gscButNotTracked` are also retired. No replacement read returns those custom groupings or comparisons. GSC query totals remain available through `google query-totals`; the tracked basket remains available through `query list` (`GET /projects/:name/queries`, MCP `canonry_queries_list`). Missing GSC rows do not establish zero search demand.

Content reads retain saved "mark addressed" records. Use `content dismissals <project>` to inspect them, `content dismiss <project> <targetRef> [--addressed-url <url>] [--note <text>]` to save one, and `content restore <project> <targetRef>` to remove one. Dismiss and restore require write authority. REST restore returns HTTP 204; CLI and MCP return `{ "targetRef": "...", "restored": true }`.

## Traffic analytics

```bash
canonry traffic analytics example --period 30 --format json
```

The REST endpoint accepts `period=7|14|30|90`. The default is 30 days.
The MCP tool accepts the same `period` values.
All three surfaces return the same JSON envelope: `{ "activity": ... }`.

`activity` contains current and prior totals, operator counts, daily trends, and the busiest paths and referring products. Ranked path lists contain at most ten entries.
The database aggregates every stored hourly row in the selected window before it limits the ranked lists.
The detail-row limit on `traffic events` does not affect these totals.
Crawler verification, user fetches, referral redirects, and paid, organic, and unclassified arrivals retain separate counts.

When the project has no non-archived traffic source, `activity` is null.
A zero count means no matching events were stored for that metric and window. It does not establish measurement coverage or a successful source sync.
`hasData` indicates qualifying stored evidence in the selected or prior window, including selected-window referral redirects. A false value does not distinguish an idle, paused, errored, or never-synced source.
`coverageStart` is the earliest stored crawler, user-fetch, or referral observation for the project, or null when no observation exists. `priorWindowComplete` states whether that recording start is no later than the prior window's start. When false, all headline, arrival-class, and operator `deltaPct` values are null; raw current and prior totals remain available.
These fields describe recording onset, not continuous collection or matching source coverage in both windows. Check source status and sync evidence before interpreting a traffic change.
The prior window excludes the current window's start, so a boundary row counts once.
This read calls no provider and writes no data.
