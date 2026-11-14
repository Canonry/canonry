# integration-google-analytics

## Purpose

Google Analytics 4 (GA4) client for traffic data, AI referral metrics, and session summaries.

## Key Files

| File | Role |
|------|------|
| `src/ga4-client.ts` | GA4 Data API client — traffic snapshots, AI referral tracking, dimension queries |
| `src/types.ts` | Type definitions and custom error class |
| `src/constants.ts` | API URLs, metric/dimension names |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Authentication.** Report methods accept a bearer access token. `getAccessToken` exchanges service account credentials for a token. The GA4 routes use a configured service account first and fall back to the stored Google OAuth connection. Credentials live in `~/.canonry/config.yaml`.
- **AI referral tracking**: Queries GA4 for traffic from AI answer engines (source dimension tracking) to correlate with visibility data. Each attribution pass ORs its source patterns with GA4's `AI Assistant` channel, and only with the channel derived from that pass's own source (`AI_REFERRAL_PASSES`): rows are deduplicated per (date, source), so another lens's channel can file one visit under a second source and count it twice. The manual UTM pass has no channel because GA4 has none for it. A pass GA4 refuses with the channel is re-read with the patterns alone. The source patterns (`AI_REFERRAL_SOURCE_FILTERS`) are built from `AI_REFERRAL_ENGINE_DEFINITIONS` in contracts, so add an engine or shape there; never add a bare engine name as a `CONTAINS` filter, because GA4 applies it server side and it selects every source that contains the word (`ngrok` for grok, `philanthropic.org` for anthropic). Test against `test/fixtures/ga4-ai-referrals-ai-assistant-channel.json` (live request bodies).
- **Date-only totals.** `fetchDailyTotals` reads `totalUsers`, `activeUsers`, and `newUsers` with `date` as the only dimension. GA4 deduplicates the user counts within each day. Adding `newVsReturning` would split the rows that `ga_daily_totals` stores at the date grain.
- **Sync window.** `POST /ga/sync` uses `resolveGa4SyncDays` to bound the requested detail window to `[1, GA4_MAX_SYNC_DAYS]` (currently 180 days). The response includes the effective `days`, `requestedDays`, and `clamped`. If `clamped` is true, the CLI warns on stderr. Daily totals use `GA_OVERVIEW_HISTORY_DAYS` to cover both the longest overview window and its previous period.
- **Search Console landing pages are window snapshots with GA4 totals only**: `fetchSearchLandingPages` sends ONE `runReport` per `7d` / `28d` / `90d` / `180d` window (ending yesterday in the property time zone; a supplied `timeZone` and `now` pin explicit calendar bounds across I/O, otherwise GA4 resolves `NdaysAgo` to `yesterday` and the stored dates come from `metadata.timeZone`), dimension `landingPagePlusQueryString`, the four `organicGoogleSearch*` metrics plus `activeUsers`, and `metricAggregations: ['TOTAL']`. That shape reproduced GA4's own report, Total included, on a live linked property (fixture: `test/fixtures/ga4-search-console-landing-pages.json`, the live response shape with synthetic values and paths). The optional `windows` selection fetches only missing or stale complete windows; fresh identical windows can be reused by the API. It must be nonempty, unique, and supported. This report has no daily-gap reuse: distinct Active users and GA4 totals remain native full-window figures. Bump `GA4_SEARCH_LANDING_REPORT_DEFINITION` when request or parsing semantics change so old receipts cannot be reused. The Total comes from `totals` and is never summed from rows; rows without a TOTAL row throw. It pages with `limit` / `offset`, clicks then impressions descending, up to `GA4_SEARCH_LANDING_MAX_ROWS` per window (clamped to what `GA4_MAX_PAGES` pages can read, never a page-limit error) and sets `rowsCapped` when GA4 reported more. CTR and position are null when impressions are 0. A 400 naming the Search Console metrics or calling them incompatible, or an all-empty report with an `emptyReason`, returns `unavailable` instead of throwing; that is how an unlinked property is EXPECTED to answer, but it has not been captured live.
- **Incremental history**: syncs keep native 7d/30d/90d/180d totals and their previous periods, because distinct users and rates cannot be added across days. Daily reports accept explicit bounded date ranges for missing coverage. API coverage receipts reuse mature days, refresh two weeks, and reconcile older days monthly. Incomplete pagination throws rather than marking truncated data complete. Detail syncs accept up to 180 days; the Activity Sync action requests its selected range.
- **Offset paging goes through `fetchPagedReport`, never a hand-written loop**: GA4 promises no row order between page requests, and a day it is still collecting changes mid-read, so an unordered `limit` / `offset` read can return one row on two pages and skip another. The stored daily grains are unique, so one repeated row fails the whole sync. `fetchPagedReport` orders every report by all of its dimensions (`ALPHANUMERIC`, a total order because GA4 returns one row per tuple), starts the read over when a page repeats a row already read, and throws after three moving reads. The capped Search Console windows keep their own metric order with a landing-page tiebreak and a dedup.
- **Nullable daily metrics.** `GA4DailyTotalRow` preserves missing readings as `null` for nullable metrics such as `engagementRate`, `newUsers`, and `activeUsers`. A zero represents a measured value for these fields.

## Common Mistakes

- **Not handling GA4 API quotas** — the Data API has per-property rate limits.

## See Also

- `docs/google-analytics-setup.md` — user-facing setup guide
- `packages/api-routes/src/ga.ts` — API routes that use this client
