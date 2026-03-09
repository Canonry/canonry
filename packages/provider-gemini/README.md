# Gemini Provider Package

`@ainyc/aeo-platform-provider-gemini` is the first answer-visibility provider adapter. It executes tracked queries against the Gemini API and normalizes citation results.

Provider contract: `validateConfig`, `healthcheck`, `executeTrackedQuery`, `normalizeResult`.

Defaults: max 2 concurrent, 10 req/min, 1000 req/day. Retry with exponential backoff on 429/5xx/timeouts.
