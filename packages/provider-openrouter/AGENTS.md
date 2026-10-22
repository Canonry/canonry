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
- The catalog lists models that answer in text. It leaves out `:batch` variants
  (batch routing, not a model) and image, music or speech generators (any `image` or `audio` output);
  `:free` variants stay. Each entry also carries the optional context window,
  output cap, per-million prices, input modalities, tool and reasoning support
  read from the same response; Aero builds models pi-ai lacks from them. Sweeps
  ignore them and `GET /settings` strips them.
- Jev and model routers are excluded from sweep choices. Jev uses the dedicated
  decisions API in `integration-typesafe`; Aero/domain classification use pi,
  with models from this catalog (`packages/canonry/src/agent/openrouter-models.ts`).

Read root AGENTS.md and the test-audit skill before changing tests.
