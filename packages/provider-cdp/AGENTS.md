# provider-cdp

## Purpose

The `cdp:chatgpt` adapter uses Chrome DevTools Protocol (CDP) to submit tracked queries to the ChatGPT web UI. It reads the rendered answer and citations.

## Key Files

| File | Role |
|------|------|
| `src/adapter.ts` | Exports `cdpChatgptAdapter` — the `ProviderAdapter` object |
| `src/normalize.ts` | Response normalization to standard `NormalizedQueryResult` |
| `src/connection.ts` | `CDPConnectionManager` — manages browser connections via CDP. `healthcheck(signal?)` reads Chrome's `/json/version` itself (`CDP.Version` takes no signal) at the host's resolved address, so an aborted connection test cancels its request |
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

### Browser connection and evidence

- Connect to a running Chrome instance with remote debugging enabled and a signed-in ChatGPT session. Use `canonry cdp connect --host <host> --port <port>`.
- The session supplies its own geolocation. Canonry's requested location does not reach the browser.
- The adapter records `retrievalStatus: unknown`. The `searchQueries` array holds the submitted query, which supplies no evidence of a search.

## Common Mistakes

- **Not handling CDP connection lifecycle** — always clean up connections to avoid resource leaks.
- **Not handling page load timing** — wait for elements to render before extracting content.
- Return browser-extracted sources in the shared `GroundingSource` format.

## See Also

- `docs/providers/README.md` — provider system overview
- `packages/contracts/src/provider.ts` — `ProviderAdapter` interface definition
