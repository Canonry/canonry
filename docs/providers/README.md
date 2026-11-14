# Provider System

## Overview

Providers are adapters that connect canonry to AI answer engines. Each provider implements the `ProviderAdapter` interface from `packages/contracts/src/provider.ts` and lives in its own package under `packages/provider-*/`.

## Available Providers

See [how Canonry selects models and measures answers](model-selection.md) for
model-selection criteria and the evidence that each adapter captures.

| Provider | Package | Mode | Service |
|----------|---------|------|---------|
| Gemini | `provider-gemini` | API | Google Gemini with `googleSearch` grounding |
| OpenAI | `provider-openai` | API | OpenAI Responses API with `web_search` |
| OpenRouter | `provider-openrouter` | API | Pinned model routes (`openrouter:publisher/model`) with web search and source annotations |
| Muse | `provider-muse` | API | Meta Model API Responses with `web_search` |
| Claude | `provider-claude` | API | Anthropic Messages API with `web_search_20250305` |
| Perplexity | `provider-perplexity` | API | Perplexity Agent API (`/v1/agent`, `fast` preset) with forced `web_search` |
| Local | `provider-local` | API | OpenAI-compatible Chat Completions endpoint (Ollama, LM Studio, vLLM) |
| ChatGPT (Browser) | `provider-cdp` | Browser | ChatGPT web UI via Chrome DevTools Protocol (`cdp:chatgpt`) |
| Search answer services | `provider-answer-services` | API | Hosted search and answer services with a shared adapter layer ([registered services](./answer-services.md#registered-services)) |

## ProviderAdapter Interface

The [shared `ProviderAdapter` interface](../../packages/contracts/src/provider.ts)
defines provider identity, location support, model validation, connection checks,
execution, and normalization. Optional capabilities include model discovery,
plain text generation, batch execution, and route families.

OpenRouter uses one connection for several pinned model routes. Search answer
services use one connection per vendor and one route per profile. Each vendor
supplies a descriptor, request builder, and parser to the shared factory.
See [Search answer services](./answer-services.md).

## How to Add a New Provider

For a hosted search answer service, follow the [vendor checklist](./answer-services.md#adding-a-vendor).
For a new API answer engine, follow these steps.

1. Export the `ProviderAdapter` from `packages/provider-<name>/src/adapter.ts`. Keep provider-specific request and response handling in that package.
2. Add the identity and location handling to `packages/contracts/`.
3. Register the adapter in `packages/canonry/src/server.ts`. Add configuration, package dependencies, the Cloud API catalog, and the Vitest project.
4. Add citation capture and stored-response backfill when the response supplies the evidence.
5. Add `docs/providers/<name>.md` and update `skills/canonry/references/canonry-cli.md`.

## Provider-Specific Documentation

- [Gemini](./gemini.md) — Google Search grounding, support-based citation selection, grounding redirects
- [OpenAI](./openai.md) — web_search tool, URL annotation extraction, web_search_call query parsing
- [OpenRouter](./openrouter.md) — multi-model setup, separate sweep identities, Aero and evaluator roles
- [Search answer services](./answer-services.md): profiles, never-implicit selection, source relationships, completion and usage basis, adding a vendor
- [Muse](./muse.md) — native web search, observed retrieval status, final-answer URL citations
- [Claude](./claude.md) — web_search_20250305 tool, final-text citation extraction, tool error handling
- [Perplexity](./perplexity.md) — Agent API presets, `search_results` output item, retired Sonar ids, stored Sonar history
- [Local](./local.md) — OpenAI-compatible endpoints, no web search grounding
- [ChatGPT (Browser)](../../packages/provider-cdp/AGENTS.md) — CDP connection and browser capture


## Available models and Research defaults

`canonry serve` discovers model choices from the configured OpenAI, Claude,
Gemini, Muse, OpenRouter, and local providers using metadata-only list-models requests. It does
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
