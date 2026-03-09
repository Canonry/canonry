# Gemini Provider Design

## Role

`packages/provider-gemini` is the first answer-visibility provider adapter.

## Provider Contract

- `validateConfig`
- `healthcheck`
- `executeTrackedQuery`
- `normalizeResult`

## Defaults

- max 2 in-flight requests per workspace
- 10 requests per minute
- 1000 requests per day

## Retry Policy

Retry:

- `429`
- timeouts
- `5xx`

With full-jitter exponential backoff up to 4 total attempts. Fail non-429 `4xx` responses immediately.

## Persistence Expectations

Persist:

- request metadata
- raw response payload
- answer text
- grounding evidence
- normalized cited URLs
- normalized cited domains
- canonical vs competitor domain matches

## Phase 1 Status

Phase 1 only introduces the stub contract and normalization entrypoints. No live Gemini calls are implemented yet.
