# provider-openrouter

OpenRouter answer adapter. Credentials belong to the `openrouter` connection;
each selected model has an immutable `openrouter:publisher/model` provider key.
Direct and routed observations never share snapshot or comparison identity.

- `src/adapter.ts` implements the provider boundary and metadata-only catalog.
- Sweeps send the exact query with the OpenRouter web-search server tool required.
  Search policy is internal, not a model-picker option. Location is unapplied.
- Freeze requested model, preserve response model verbatim, and disable model and
  endpoint fallbacks. Missing search evidence remains `unknown`.
- Citation domains come only from valid `url_citation` annotations. Prose domains
  do not become citations. Shared mention extraction remains downstream.
- Key validation and catalog discovery never generate an answer. All HTTP calls
  use the shared retry wrapper and honor Retry-After.
- Jev and model routers are excluded from sweep choices. Jev uses the dedicated
  decisions API in `integration-typesafe`; Aero/domain classification use pi.

Read root AGENTS.md and the test-audit skill before changing tests.
