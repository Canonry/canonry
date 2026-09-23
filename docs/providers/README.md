# Provider System

## Overview

Providers are adapters that connect canonry to AI answer engines. Each provider implements the `ProviderAdapter` interface from `packages/contracts/src/provider.ts` and lives in its own package under `packages/provider-*/`.

## Available Providers

See [why we use model providers' APIs directly](model-selection.md) for the
model-selection criteria and the answer and citation evidence that each adapter captures.

| Provider | Package | Mode | Service |
|----------|---------|------|---------|
| Gemini | `provider-gemini` | API | Google Gemini with `googleSearch` grounding |
| OpenAI | `provider-openai` | API | OpenAI Responses API with `web_search` |
| Muse | `provider-muse` | API | Meta Model API Responses with `web_search` |
| Claude | `provider-claude` | API | Anthropic Messages API with `web_search_20250305` |
| Perplexity | `provider-perplexity` | API | Perplexity Sonar / OpenAI-compatible Chat Completions |
| Local | `provider-local` | API | Any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM) |
| CDP | `provider-cdp` | Browser | Chrome DevTools Protocol (e.g., ChatGPT UI automation) |

## ProviderAdapter Interface

Every provider must implement:

```typescript
interface ProviderAdapter {
  name: string              // e.g., 'gemini'
  displayName: string       // e.g., 'Google Gemini'
  mode: 'api' | 'browser'
  supportsLocationContext: boolean
  modelRegistry: ProviderModelRegistry
  keyUrl?: string           // URL where users get an API key

  listModels?(config: ProviderConfig, signal: AbortSignal): Promise<ModelDefinition[]>
  validateConfig(config: ProviderConfig): ProviderHealthcheckResult
  healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult>
  executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult>
  normalizeResult(raw: RawQueryResult): NormalizedQueryResult
  generateText(prompt: string, config: ProviderConfig): Promise<string>
}
```

## How to Add a New Provider

1. Create `packages/provider-<name>/` with the standard 4-file structure:
   - `src/adapter.ts` — export the `ProviderAdapter` object
   - `src/normalize.ts` — implement the 5 interface functions
   - `src/types.ts` — provider-specific config and response types
   - `src/index.ts` — re-export public API
2. Add the provider to the shared identity constants and location handling in `packages/contracts/`. `ProviderName` is a string validated against registered adapters.
3. Register the adapter in `packages/canonry/src/server.ts`. Add configuration, package dependencies, the Cloud API catalog, and the Vitest project. Include citation capture and stored-response backfill when supported.
4. Add a `docs/providers/<name>.md` file documenting service-specific quirks.
5. Update the skills reference in `skills/canonry/references/canonry-cli.md`.

## Provider-Specific Documentation

- [Gemini](./gemini.md) — googleSearch grounding, support-based citation selection, base64 proxy URLs
- [OpenAI](./openai.md) — web_search tool, URL annotation extraction, web_search_call query parsing
- [Muse](./muse.md) — native web search, observed retrieval status, final-answer URL citations
- [Claude](./claude.md) — web_search_20250305 tool, final-text citation extraction, tool error handling
- [Perplexity](./perplexity.md) — `search_results` vs `citations`, no returned search-query telemetry
- [Local](./local.md) — OpenAI-compatible endpoints, no web search grounding


## Available models and Research defaults

`canonry serve` discovers model choices from the configured OpenAI, Claude,
Gemini, Muse, and local providers using metadata-only list-models requests. It does
not generate answers or consume research/sweep quota. Requests use the same
credentials and endpoints as those providers, including Gemini Vertex AI.
The per-install catalog caches successful discovery for one hour, shares
concurrent lookups, and limits page-load waiting to three seconds. Credential
or endpoint changes invalidate that provider's cache. A failed refresh retains
the last successful list, or the bundled choices on a cold start. Unconfigured
providers keep bundled suggestions without attempting discovery, and empty or
blank-only refreshes never replace the last usable catalog. Failures
back off for at least one minute and honor longer provider Retry-After values. Providers/hosts without model discovery, including
the standalone Cloud API host, retain bundled choices.

Muse discovers Standard tier models and includes bundled suggestions. Canonry omits Contributor models
from automatic choices because Meta permits training on their prompts and completions.
An exact model override remains available for operators who choose that tier.

The choices flow through the existing settings and research-list APIs. New
models become available without a release. Discovery does not choose a new
execution default or change a project, frozen measurement, or saved answer.
Model-list APIs do not guarantee that every listed model supports the answer
adapter's search tools; non-answer modalities and legacy OpenAI GPT-3.5/GPT-4
Chat Completions models are filtered, and an operator
can still supply an exact supported model ID.

Research defaults use the same precedence as AI Visibility: project model,
then the instance's configured model, then the adapter default. The viewer
picker labels this **Use AI Visibility model** and always includes it, even
when the configured alias is absent from discovery. Explicit research model
choices apply only to that batch; changing engines clears that override.
Each created batch freezes its resolved model, and saved results retain their
requested and provider-reported served model identities.

Provider list APIs: [OpenAI](https://developers.openai.com/api/reference/resources/models/methods/list),
[Claude](https://platform.claude.com/docs/en/api/models/list),
[Gemini](https://ai.google.dev/api/models),
[Muse](https://dev.meta.ai/docs/models).

Project engine settings also show the configured instance model in the inheritance
option, including custom aliases that do not appear in model discovery.

OpenAI compatibility references: [GPT-3.5 Turbo](https://developers.openai.com/api/docs/models/gpt-3.5-turbo),
[GPT-4](https://developers.openai.com/api/docs/models/gpt-4), and
[Responses web search](https://developers.openai.com/api/docs/guides/tools-web-search).
