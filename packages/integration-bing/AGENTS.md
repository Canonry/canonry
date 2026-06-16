# integration-bing

## Purpose

Bing Webmaster Tools integration — API client for fetching URL inspection data, keyword stats, site-level metrics, and inbound links from Bing's Webmaster API.

## Key Files

| File | Role |
|------|------|
| `src/bing-client.ts` | Bing Webmaster API client — URL inspections, keyword stats, site info, and inbound links (`getLinkCounts` → `GetLinkCounts` pages-with-inbound-links + `getUrlLinks` → `GetUrlLinks` per-page linking URLs; both auto-paginate across `TotalPages`, bounded by `BING_LINKS_MAX_PAGES`). The inbound-link methods back canonry's `source='bing-webmaster'` backlinks. |
| `src/types.ts` | Type definitions and `BingApiError` custom error class |
| `src/constants.ts` | API URLs, timeouts |
| `src/index.ts` | Re-exports public API |

## Patterns

- **API key auth**: Uses a Bing Webmaster API key stored in `~/.canonry/config.yaml`.
- **Error handling**: Uses `BingApiError` for API-specific errors.

## Common Mistakes

- **Storing API keys in the database** — credentials belong in `~/.canonry/config.yaml`.

## See Also

- `docs/bing-webmaster-setup.md` — user-facing setup guide
- `packages/api-routes/src/bing.ts` — API routes that use this client
