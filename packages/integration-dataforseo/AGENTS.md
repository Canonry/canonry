# integration-dataforseo

DataForSEO is the first adapter for the provider-neutral `SeoAdapter` in contracts.

- `src/client.ts` is the paid HTTP boundary. Retry only confirmed unaccepted throttles using shared retry helpers. Never retry uncertain paid POSTs or HTTP-200 mixed-success responses.
- `src/adapter.ts` validates and prices the exact request before dispatch. Keyword metrics, ranked keywords and domain intelligence are bounded Google Labs Live tasks: they retrieve database observations, not newly measured search results. Market rankings are the exception: one SERP live search per request, a Google results page measured at request time, priced per 10 results checked, and at 5× when the search text contains an operator on DataForSEO's surcharge list (`site:`, `intitle:` …; matched anywhere, ignoring case, so the reservation never falls short). The payload escapes `%` and `+`, which DataForSEO decodes; the search text, identity check and stored rows stay plain.
- A market-rankings task with status 40106 ("completed with partial results": some results pages could not be retrieved, and only the returned ones are charged) keeps its results as a `partial` search whose row `depth` is the deepest organic position returned. A 40106 with no organic result is a failed search. Labs tasks still count only 20000 as collected.
- A market-rankings result whose every task is 40101 (the search engine returned an error) with a known cost is `retryable`: `SeoRepository.settle` queues one new attempt, with its own reservation, that claims take after every first attempt. Never mark an unknown or uncertain outcome retryable; 40102 (no results) and 40103 (failed on the source's side) are not retried.
- Market rankings report competitors per market: a search shared by markets ranks every competitor any of them tracks, and each market's row keeps only its own (`SeoMarketRankingSearchMarket.competitors`).
- `src/normalize.ts` decodes official payloads into typed evidence. Missing metrics and missing task cost remain null. Provider text and raw bodies never enter customer errors.
- Credentials come from host config.yaml. The adapter account key hashes normalized login and is stable across connection aliases and password rotation.
- No network request during construction, estimation, status, or stored reads. Tests mock the global fetch boundary; never use paid credentials.
