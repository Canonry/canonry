# integration-cloro

cloro is an opt-in `SeoAdapter` for one capability: market rankings. DataForSEO keeps keyword metrics, ranked keywords, domain intelligence, competitor discovery and keyword gaps.

- `src/client.ts` is the paid HTTP boundary (`POST https://api.cloro.dev/v1/monitor/google`, sync, 6-minute timeout because cloro can finish an attempt after 5 minutes). cloro charges only for a 200, so every other status is a free refusal. Only 429 and 503 are retried, through the shared retry helpers; a 500 comes after cloro has already retried. A lost or unread response is never retried.
- `src/adapter.ts` validates and prices the exact request before dispatch. One search per request, `pages` = depth / 10. Credits: 3 for the first page, 2 for each further page, 2 for sync. The host config sets `creditMicros`, the money value of one credit on its plan, because cloro bills in credits. The receipt multiplies the `X-Credits-Charged` header by it; a missing header leaves the cost null, so the refresh waits for reconciliation.
- Location: a Google Ads country criterion (2000 + ISO numeric, from `src/countries.ts`) is sent as `country`. Any other location must have its Google canonical name as its label ("Dallas,Texas,United States"); it is sent as `location`, and its last part gives the country. Anything else is refused before a paid call.
- On mobile, Google serves most organic links through `https://www.google.com/goto?…`, and cloro returns an empty `link`. The site then comes from `displayedLink` and the row stores no page address. A result with neither names no site. A results set with no organic result, or none with a known site, is a failed search with its charge kept. cloro retries internally, so no result is `retryable`.
- `position` counts organic results across all pages, so `rankOrganic` and `rankAbsolute` are the same.
- The account key is a hash of the API key: a new key starts a new funding ledger.
- No network request during construction or estimation. Tests mock the global fetch boundary; never use a real key.
