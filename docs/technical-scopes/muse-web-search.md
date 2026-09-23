# Muse web search scope

## Goal

Add Muse Spark as a direct answer provider for Simple and Advanced Measurement. Use `muse-spark-1.3` on the Standard tier by default.

## Boundaries

- Use the Meta Responses API at `https://api.meta.ai/v1` with `web_search`. Let Muse decide whether to search.
- When a run has a location, pass its structured fields through the approximate `user_location` field.
- Record `native-auto-v1` and an observed `used`, `not-used`, or `unknown` retrieval status.
- Count citations only from `url_citation` annotations on final `output_text`. Do not request `web_search_call.results`.
- Store refused and `incomplete` answers as observations; fail the query only for other response statuses.
- Store the key under `providers.muse`; accept `MUSE_API_KEY`. Expose `MUSE_MODEL`, `MUSE_BASE_URL`, and `init --muse-key`.
- Expose Muse through provider settings, project selection, run overrides, API, CLI, MCP, and both measurement paths.
- Keep Contributor tier models out of automatic suggestions. Exact model overrides remain an explicit opt in to Meta's training terms.
- Measure Meta Model API output only. Do not infer behavior in Meta consumer products.

## Validation

Use adapter tests for request shape, search status, citation extraction, and malformed responses. Use API and CLI tests for provider selection, run admission, and frozen Advanced scopes. Check the MCP transport and generated contract. No live Meta call is part of the local test suite.

References: [Search grounding](https://dev.meta.ai/docs/search-grounding), [models](https://dev.meta.ai/docs/models).
