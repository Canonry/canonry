# integration-google

## Purpose

Google Search Console (GSC) integration — OAuth 2.0 flow for Google credentials and a GSC API client for fetching search performance data, URL inspections, and coverage reports.

## Key Files

| File | Role |
|------|------|
| `src/gsc-client.ts` | GSC API client — search analytics queries, URL inspection, coverage, sitemaps |
| `src/oauth.ts` | Google OAuth 2.0 flow — authorization URL generation, token exchange, refresh |
| `src/types.ts` | Type definitions and `GoogleApiError` custom error class |
| `src/constants.ts` | API URLs, OAuth scopes, timeouts |
| `src/index.ts` | Re-exports public API |

## Patterns

- **OAuth flow**: The `oauth.ts` module handles the full OAuth 2.0 authorization code flow. Credentials (client ID/secret, access/refresh tokens) are stored in `~/.canonry/config.yaml`, not the database.
- **Error handling**: Uses `GoogleApiError` for API-specific errors. Callers in `packages/api-routes` catch and wrap these as `AppError`.
- **Token refresh**: Access tokens expire — the client handles transparent refresh using the stored refresh token.

## Common Mistakes

- **Storing OAuth tokens in the database** — credentials belong in `~/.canonry/config.yaml`.
- **Not handling token expiry** — always use the refresh flow for long-lived integrations.

## See Also

- `docs/google-search-console-setup.md` — user-facing setup guide
- `packages/api-routes/src/google.ts` — API routes that use this client
