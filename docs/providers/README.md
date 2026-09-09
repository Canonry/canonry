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
  keyUrl?: string           // URL where users get an API key

  validateConfig(config: ProviderConfig): ValidationResult
  healthcheck(config: ProviderConfig): Promise<HealthcheckResult>
  executeTrackedQuery(input: TrackedQueryInput): Promise<RawQueryResult>
  normalizeResult(raw: RawQueryResult): NormalizedQueryResult
  generateText(config: ProviderConfig, prompt: string): Promise<string>
}
```

## How to Add a New Provider

1. Create `packages/provider-<name>/` with the standard 4-file structure:
   - `src/adapter.ts` — export the `ProviderAdapter` object
   - `src/normalize.ts` — implement the 5 interface functions
   - `src/types.ts` — provider-specific config and response types
   - `src/index.ts` — re-export public API
2. Add the provider name to the `ProviderName` union in `packages/contracts/src/provider.ts`.
3. Import and register the adapter in `packages/canonry/src/server.ts`.
4. Add a `docs/providers/<name>.md` file documenting service-specific quirks.
5. Update the skills reference in `skills/canonry/references/canonry-cli.md`.

## Provider-Specific Documentation

- [Gemini](./gemini.md) — googleSearch grounding, support-based citation selection, base64 proxy URLs
- [OpenAI](./openai.md) — web_search tool, URL annotation extraction, web_search_call query parsing
- [Claude](./claude.md) — web_search_20250305 tool, final-text citation extraction, tool error handling
- [Perplexity](./perplexity.md) — `search_results` vs `citations`, no returned search-query telemetry
- [Local](./local.md) — OpenAI-compatible endpoints, no web search grounding


## Available models and Research defaults

`canonry serve` discovers model choices from the configured OpenAI, Claude,
Gemini, and local providers using metadata-only list-models requests. It does
not generate answers or consume research/sweep quota. Requests use the same
credentials and endpoints as those providers, including Gemini Vertex AI.
The per-install catalog caches successful discovery for one hour, shares
concurrent lookups, and limits page-load waiting to three seconds. Credential
or endpoint changes invalidate that provider's cache. A failed refresh retains
the last successful list, or the bundled choices on a cold start; failures
back off for at least one minute and honor longer provider Retry-After values. Providers/hosts without model discovery, including
the standalone Cloud API host, retain bundled choices.

The choices flow through the existing settings and research-list APIs. New
models become available without a release. Discovery does not choose a new
execution default or change a project, frozen measurement, or saved answer.
Model-list APIs do not guarantee that every listed model supports the answer
adapter's search tools; non-answer modalities are filtered, and an operator
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
[Gemini](https://ai.google.dev/api/models).
