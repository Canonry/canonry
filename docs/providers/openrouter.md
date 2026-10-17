# OpenRouter models

Add an OpenRouter key once in Settings → Providers. Select **Choose project models**, then use **Add models** in the project's Answer engines settings. Search the model catalog and select several models, or enter a concrete `publisher/model` ID. Save the selection before the next sweep.

Each model appears as a separate answer engine. Gemini through its direct API and Gemini through OpenRouter have separate results, filters and history. OpenRouter models share one connection and its concurrency, minute and daily limits. An empty project provider list includes configured direct engines; it does not select every OpenRouter model.

The CLI uses the same flow:

```bash
cnry settings provider openrouter --api-key <key>
cnry project update my-site \
  --provider gemini \
  --provider openrouter:google/gemini-3.1-flash-lite \
  --provider openrouter:anthropic/claude-sonnet-4.6
cnry run my-site --wait
```

`project update --provider` replaces the saved provider list. These route names also work in run overrides, schedules, config apply, MCP, and Advanced Measurement contexts. A route pins its model; choose another route to change it. Adding a model requires `settings.write`, like direct model overrides. API and CLI result JSON keep the full route name.

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

Aero, recommendation analysis and domain classification read their OpenRouter models from the same live catalog as the sweep picker: one request to OpenRouter's model list, cached for an hour per key (retried after a minute when it fails). A model OpenRouter adds is usable without a Canonry update. Models pi-ai already knows keep pi's settings; a newer model is called through OpenRouter's chat completions API with the limits and prices the catalog lists. With reasoning off, such a model gets no reasoning setting in the request, so OpenRouter applies the model's default. When the catalog cannot be read, Aero uses pi-ai's bundled OpenRouter list. A conversation already on a model outside that list keeps it: the turn fails with a message naming the model until the catalog can be read again, and the conversation is not moved to the default. The Aero picker and `GET /projects/:name/agent/providers` (`models` on the OpenRouter entry) list only models the catalog marks as supporting tools, since Aero calls tools.

The catalog is read with whichever OpenRouter key Aero uses: `providers.openrouter.apiKey` in config.yaml, or `OPENROUTER_API_KEY` when only the environment sets one. An environment-only key gives Aero, analysis and classification the live list, but sweeps still need the key in config.yaml (`cnry settings provider openrouter --api-key <key>`, or bootstrap, which saves it there).

`canonry doctor` checks a pinned `agent.model` against the live list, loading it first when an OpenRouter key is set, so the result does not depend on whether Aero has run since the server started. While the catalog cannot be read, a well-formed `publisher/model` ID is not reported as invalid.

Defaults when no model is set: Aero, analysis and classification all use `openai/gpt-6-luna`. It is in pi-ai's bundled list, so it works while the catalog is unreachable. A served model that the transport does not disclose remains unknown. Branded/non-brand query classification and citation/mention matching remain deterministic shared operations.

Sentiment remains a separate, opt-in Jev evaluator. OpenRouter uses pi's classifier transport with the shared OpenRouter key. Evaluator definitions and usage identify the route separately from the answer model being assessed. Changing evaluator provider requires reconfiguring project sentiment; queued work never silently changes evaluators.

## Measurement evidence

The adapter requests OpenRouter's [web search server tool](https://openrouter.ai/docs/guides/features/server-tools/web-search) internally. No search-engine selector is exposed in setup. Each request keeps the tracked query unchanged and disables provider fallback. The concrete requested model and the literal served model are recorded independently.

Only `url_citation` annotations contribute source links. URLs in prose never create citations. Mentions are computed independently from answer prose. Search use is recorded from reported search requests or source annotations; absent evidence stays unknown. Requested locations are retained as ignored because generic routing cannot promise geographic support. These rules apply to Simple and Advanced Measurement.

The catalog and connection checks use metadata endpoints without generating answers. Token and search usage come from the response; costs stay unknown unless an operator supplies pricing. The upstream server-tool API is currently beta. This measures API routes and does not claim parity with consumer Gemini, ChatGPT or Claude interfaces.
