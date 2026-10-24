# integration-dataforseo

DataForSEO is the first adapter for the provider-neutral `SeoAdapter` in contracts.

- `src/client.ts` is the paid HTTP boundary. Retry only confirmed unaccepted throttles using shared retry helpers. Never retry uncertain paid POSTs or HTTP-200 mixed-success responses.
- `src/adapter.ts` validates and prices the exact request before dispatch; all calls are bounded Google Labs Live tasks. Live retrieves database observations, not newly measured search results.
- `src/normalize.ts` decodes official payloads into typed evidence. Missing metrics and missing task cost remain null. Provider text and raw bodies never enter customer errors.
- Credentials come from host config.yaml. The adapter account key hashes normalized login and is stable across connection aliases and password rotation.
- No network request during construction, estimation, status, or stored reads. Tests mock the global fetch boundary; never use paid credentials.
