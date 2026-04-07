# Provider System

## Overview

Providers are adapters that connect canonry to AI answer engines. Each provider implements the `ProviderAdapter` interface from `packages/contracts/src/provider.ts` and lives in its own package under `packages/provider-*/`.

## Available Providers

| Provider | Package | Mode | Service |
|----------|---------|------|---------|
| Gemini | `provider-gemini` | API | Google Gemini with `googleSearch` grounding |
| OpenAI | `provider-openai` | API | OpenAI Responses API with `web_search_preview` |
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
5. Update the skills reference in `skills/canonry-setup/references/canonry-cli.md`.

## Provider-Specific Documentation

- [Gemini](./gemini.md) — googleSearch grounding, support-based citation selection, base64 proxy URLs
- [OpenAI](./openai.md) — web_search_preview tool, URL annotation extraction, web_search_call query parsing
- [Claude](./claude.md) — web_search_20250305 tool, final-text citation extraction, tool error handling
- [Perplexity](./perplexity.md) — `search_results` vs `citations`, no returned search-query telemetry
- [Local](./local.md) — OpenAI-compatible endpoints, no web search grounding
