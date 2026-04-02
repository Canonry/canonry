# integration-wordpress

## Purpose

WordPress integration — REST API client for managing WordPress sites, generating structured data (schema.org), and syncing AEO optimization recommendations with WordPress content.

## Key Files

| File | Role |
|------|------|
| `src/wordpress-client.ts` | WordPress REST API client (largest integration at 1,186 LOC) — site management, content sync, schema generation |
| `src/schema-templates.ts` | Schema.org JSON-LD templates for structured data generation |
| `src/types.ts` | Type definitions and `WordpressApiError` custom error class |
| `src/index.ts` | Re-exports public API |

## Patterns

- **REST API auth**: Uses WordPress application passwords or API keys stored in `~/.canonry/config.yaml`.
- **Schema generation**: `schema-templates.ts` provides templates for FAQ, HowTo, Article, and other schema.org types.
- **Error handling**: Uses `WordpressApiError` for API-specific errors.

## Common Mistakes

- **Storing WordPress credentials in the database** — credentials belong in `~/.canonry/config.yaml`.
- **Not handling WordPress API pagination** — large sites may require paginated requests.

## See Also

- `docs/wordpress-setup.md` — user-facing setup guide
- `packages/api-routes/src/wordpress.ts` — API routes that use this client
