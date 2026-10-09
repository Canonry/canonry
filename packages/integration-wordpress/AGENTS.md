# integration-wordpress

## Purpose

WordPress integration — REST API client for managing WordPress sites, generating structured data (schema.org), and syncing AEO optimization recommendations with WordPress content.

## Key Files

| File | Role |
|------|------|
| `src/wordpress-client.ts` | WordPress REST API client — site management, content sync, schema generation |
| `src/schema-templates.ts` | Schema.org JSON-LD templates for structured data generation |
| `src/types.ts` | Type definitions and `WordpressApiError` custom error class |
| `src/index.ts` | Re-exports public API |

## Patterns

- **REST API auth**: Uses WordPress application passwords or API keys stored in `~/.canonry/config.yaml`.
- **Schema generation**: `schema-templates.ts` owns LocalBusiness, Organization, FAQPage, Service, and WebPage JSON-LD. Pin complete independent template output in its tests; use the real profile deployment and persisted refetch to cover string/object/FAQ parsing.
- **Egress**: every request (REST calls, the home page, rendered page `link`s, `llms.txt`) goes through `connection.fetchImpl` (`WordpressClientConnection`), falling back to global `fetch`. `api-routes` passes `createGuardedFetch` on every call so each address and redirect hop is checked. Never call `fetch` directly here, and never persist `fetchImpl`: the store takes the plain `WordpressConnectionRecord`.
- **Error handling**: Uses `WordpressApiError` for API-specific errors. Native tests capture one diagnostic from one request and preserve status/code/credential redaction.
- **Native coverage**: Assert complete page/SEO DTOs, exact audit arithmetic and thresholds, independent raw-content hashes, decoded hostile JSON-LD values, and every plugin identity across pagination.

## Common Mistakes

- **Storing WordPress credentials in the database** — credentials belong in `~/.canonry/config.yaml`.
- **Not handling WordPress API pagination** — large sites may require paginated requests.

## See Also

- `docs/wordpress-setup.md` — user-facing setup guide
- `packages/api-routes/src/wordpress.ts` — API routes that use this client
