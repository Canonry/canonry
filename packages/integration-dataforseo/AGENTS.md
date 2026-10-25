# integration-dataforseo

DataForSEO is the first adapter for the provider-neutral `SeoAdapter` in contracts.

- `src/client.ts` is the paid HTTP boundary. Retry only confirmed unaccepted throttles using shared retry helpers. Never retry uncertain paid POSTs or HTTP-200 mixed-success responses.
- `src/adapter.ts` validates and prices the exact request before dispatch. Keyword metrics, ranked keywords and domain intelligence are bounded Google Labs Live tasks: they retrieve database observations, not newly measured search results. Market rankings are the exception: one SERP live search per request, a Google results page measured at request time, priced per 10 results checked.
- Market rankings report competitors per market: a search shared by markets ranks every competitor any of them tracks, and each market's row keeps only its own (`SeoMarketRankingSearchMarket.competitors`).
- `src/normalize.ts` decodes official payloads into typed evidence. Missing metrics and missing task cost remain null. Provider text and raw bodies never enter customer errors.
- Credentials come from host config.yaml. The adapter account key hashes normalized login and is stable across connection aliases and password rotation.
- No network request during construction, estimation, status, or stored reads. Tests mock the global fetch boundary; never use paid credentials.
