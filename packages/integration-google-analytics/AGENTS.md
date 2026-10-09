# integration-google-analytics

## Purpose

Google Analytics 4 (GA4) integration — service account-based client for fetching traffic data, AI referral metrics, and session summaries from GA4 properties.

## Key Files

| File | Role |
|------|------|
| `src/ga4-client.ts` | GA4 Data API client — traffic snapshots, AI referral tracking, dimension queries |
| `src/types.ts` | Type definitions and custom error class |
| `src/constants.ts` | API URLs, metric/dimension names |
| `src/index.ts` | Re-exports public API |

## Patterns

- **Service account auth**: Uses Google service account credentials (JSON key file), not OAuth. Credentials stored in `~/.canonry/config.yaml`.
- **AI referral tracking**: Queries GA4 for traffic from AI answer engines (source dimension tracking) to correlate with visibility data.
- **Returning users are derived, never requested**: GA4 exposes `totalUsers`, `activeUsers`, and `newUsers` plus a `newVsReturning` dimension — there is no `returningUsers` metric. `fetchDailyTotals` derives it as `totalUsers - newUsers` on a report whose ONLY dimension is `date`, where GA4 has already deduplicated both counts inside the day, so the subtraction is exact at that grain. The `newVsReturning` dimension is deliberately unused: it multiplies the row count and breaks the date-only grain `ga_daily_totals` exists to hold.
- **The sync window is bounded, and the bound is reported**: every `days` argument is resolved through `resolveGa4SyncDays` (`constants.ts`), which bounds it to `[1, GA4_MAX_SYNC_DAYS]` and returns `{ requestedDays, effectiveDays, clamped }`. All six fetches use `effectiveDays`, and `POST /ga/sync` resolves through the SAME helper so the response's `days` is the window actually written, with `requestedDays` / `clamped` beside it. Never re-implement the clamp inline: `--days 500` used to return `{"days": 500}` while writing 90, and a second copy of the bound is how that silently comes back. The CLI warns on stderr when `clamped` is set.
- **Search Console landing pages are window snapshots with GA4 totals only**: `fetchSearchLandingPages` sends ONE `runReport` per `7d` / `28d` / `90d` window (`NdaysAgo` to `yesterday`, which GA4 resolves in the property time zone; the stored dates come from `metadata.timeZone`), dimension `landingPagePlusQueryString`, the four `organicGoogleSearch*` metrics plus `activeUsers`, and `metricAggregations: ['TOTAL']`. That shape reproduced GA4's own report, Total included, on a live linked property (fixture: `test/fixtures/ga4-search-console-landing-pages.json`, the live response shape with synthetic values and paths). The Total comes from `totals` and is never summed from rows; rows without a TOTAL row throw. It pages with `limit` / `offset`, clicks then impressions descending, up to `GA4_SEARCH_LANDING_MAX_ROWS` per window (clamped to what `GA4_MAX_PAGES` pages can read, never a page-limit error) and sets `rowsCapped` when GA4 reported more. CTR and position are null when impressions are 0. A 400 naming the Search Console metrics or calling them incompatible, or an all-empty report with an `emptyReason`, returns `unavailable` instead of throwing; that is how an unlinked property is EXPECTED to answer, but it has not been captured live.
- **An absent metric is `null`, never `0`**: `engagementRate` / `newUsers` / `returningUsers` on `GA4DailyTotalRow` are nullable. A property or a stored row with no reading must not report as a 0% engagement, 0-returning-user day — that is a real value, and the absence of one is not.

## Common Mistakes

- **Confusing with the Google Search Console integration** — GSC uses OAuth, GA4 uses service accounts. Different auth flows.
- **Not handling GA4 API quotas** — the Data API has per-property rate limits.

## See Also

- `docs/google-analytics-setup.md` — user-facing setup guide
- `packages/api-routes/src/ga.ts` — API routes that use this client
