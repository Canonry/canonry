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

## Common Mistakes

- **Confusing with the Google Search Console integration** — GSC uses OAuth, GA4 uses service accounts. Different auth flows.
- **Not handling GA4 API quotas** — the Data API has per-property rate limits.

## See Also

- `docs/google-analytics-setup.md` — user-facing setup guide
- `packages/api-routes/src/ga.ts` — API routes that use this client
