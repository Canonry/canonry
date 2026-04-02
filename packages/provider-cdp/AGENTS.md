# provider-cdp

## Purpose

Chrome DevTools Protocol adapter — implements `ProviderAdapter` by automating a real browser session (e.g., ChatGPT UI). Uses CDP to navigate, input queries, capture responses, and extract citations from the rendered page. This is the "bring your own browser" approach.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `cdpAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Response normalization to standard `NormalizedQueryResult` |
| `src/connection.ts` | `CDPConnectionManager` — manages browser connections via CDP |
| `src/screenshot.ts` | `captureElementScreenshot()` — captures page element screenshots |
| `src/targets/` | Target-specific automation scripts |
| `src/targets/chatgpt.ts` | ChatGPT UI automation — navigation, query input, response extraction |
| `src/targets/types.ts` | `CDPProviderError` and target type definitions |
| `src/index.ts` | Re-exports public API |

## Patterns

This provider follows the same `ProviderAdapter` interface but has a more complex implementation due to browser automation:

- **Connection management**: `CDPConnectionManager` handles connecting to/disconnecting from Chrome instances via the DevTools Protocol.
- **Target scripts**: Each target (e.g., ChatGPT) has its own automation script that knows how to navigate the UI, submit queries, and extract responses.
- **Screenshots**: Captures visual evidence of citations for debugging and verification.

### How it differs from API-based providers

- Requires a running Chrome instance with remote debugging enabled.
- User must be logged into the target service (e.g., ChatGPT).
- Slower than API calls — involves page navigation and rendering.
- More accurate results than API-based providers since it captures the actual user-facing response.

## Common Mistakes

- **Not handling CDP connection lifecycle** — always clean up connections to avoid resource leaks.
- **Not handling page load timing** — wait for elements to render before extracting content.
- **Not normalizing results to standard `CitedSource` format** — DOM-extracted data needs the same normalization as API responses.

## See Also

- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
