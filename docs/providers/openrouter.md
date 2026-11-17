# OpenRouter models

Add an OpenRouter key in **Settings → Providers**. Open **Choose project models** to go to the project's **Answer engines** settings. Open the model picker. Select a recommended model, browse the catalog, or enter a concrete `publisher/model` ID. Select **Save engines** before the next sweep. OpenRouter bills your account for the answers and web search.

Each selected model appears as a separate answer engine. Gemini's direct API and its OpenRouter routes have separate results, filters, and history. OpenRouter models share one connection and its concurrency, per-minute, and daily limits. OpenRouter routes require explicit selection.

The CLI uses the same flow:

```bash
cnry settings provider openrouter --api-key <key>
cnry project update my-site \
  --provider gemini \
  --provider openrouter:google/gemini-3.8-flash \
  --provider openrouter:anthropic/claude-sonnet-5.5
cnry run my-site --wait
```

`project update --provider` replaces the saved provider list. These route names also work in run overrides, schedules, config apply, MCP, and Advanced Measurement contexts. A route pins its model. Select a different route to change models. Selecting a route that the project has not authorized requires `settings.write`. API and CLI result JSON keep the full route name.

Credentials remain in `~/.canonry/config.yaml`. `OPENROUTER_API_KEY` is supported by bootstrap and init; `OPENROUTER_MODEL` is an optional connection default for text generation, independent of the models selected for sweeps.

```yaml
providers:
  openrouter:
    apiKey: <key>
    quota:
      maxConcurrency: 2
      maxRequestsPerMinute: 10
      maxRequestsPerDay: 1000
agent:
  provider: openrouter
  model: openai/gpt-6-luna
classification:
  provider: openrouter
  model: openai/gpt-6-luna
sentiment:
  enabled: true
  provider: openrouter
  model: typesafe/jev-1.13
```

Aero uses pi's OpenRouter transport. Its model can be selected separately in the Aero picker or with the existing `--provider openrouter --model <id>` flags. Domain classification uses the independent `classification` role; its evaluator metadata records the requested model and prompt version.

Aero, recommendation analysis and domain classification read their OpenRouter models from the same live catalog as the sweep picker: one request to OpenRouter's model list, cached for an hour per key (retried after a minute when it fails). A model OpenRouter adds is usable without a Canonry update. Models pi-ai already knows keep pi's settings; a newer model is called through OpenRouter's chat completions API with the limits and prices the catalog lists. With reasoning off, such a model gets no reasoning setting in the request, so OpenRouter applies the model's default. When the catalog cannot be read, Aero uses pi-ai's bundled OpenRouter list. A conversation already on a model outside that list keeps it: the turn fails with a message naming the model until the catalog can be read again, and the conversation is not moved to the default. If no OpenRouter key resolves at all, such a conversation takes the default instead, so the error names the missing key. The Aero picker offers a short list (`openai/gpt-6-luna`, `openai/gpt-6.1-sol`, `anthropic/claude-sonnet-5.5`, `google/gemini-3.8-flash`) plus an "Other model ID" box for any model in the catalog.

The catalog is read with whichever OpenRouter key Aero uses: `providers.openrouter.apiKey` in config.yaml, or `OPENROUTER_API_KEY` when only the environment sets one. An environment-only key gives Aero, analysis and classification the live list, but sweeps still need the key in config.yaml (`cnry settings provider openrouter --api-key <key>`, or bootstrap, which saves it there).

`canonry doctor` checks a pinned `agent.model` against the live list, loading it first when an OpenRouter key is set, so the result does not depend on whether Aero has run since the server started. While the catalog cannot be read, a well-formed `publisher/model` ID is not reported as invalid.

Defaults when no model is set: Aero, analysis and classification all use `openai/gpt-6-luna`. It is in pi-ai's bundled list, so it works while the catalog is unreachable. A served model that the transport does not disclose remains unknown. Branded/non-brand query classification and citation/mention matching remain deterministic shared operations.

Sentiment remains a separate, opt-in Jev evaluator. OpenRouter uses pi's classifier transport with the shared OpenRouter key. Evaluator definitions and usage identify the route separately from the answer model being assessed. Changing evaluator provider requires reconfiguring project sentiment; queued work never silently changes evaluators.

## Measurement evidence

The adapter sends the unchanged tracked query and requires OpenRouter's `openrouter:web_search` server tool. The request disables provider fallback. Canonry records the requested model and the reported served model separately. See [OpenRouter's tool documentation](https://openrouter.ai/docs/guides/features/server-tools/web-search).

Only `url_citation` annotations contribute source links. Canonry measures mentions from answer prose. A positive search count or a source annotation marks retrieval as `used`. With neither, retrieval stays `unknown`. The adapter always leaves `searchQueries` empty. It records requested locations as ignored. These rules apply to Simple and Advanced Measurement.

The catalog and connection checks use metadata endpoints. Token and search usage come from the response. Canonry needs configured pricing to calculate sweep costs.
