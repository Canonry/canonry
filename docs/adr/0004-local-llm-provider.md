# ADR 0004: Add a Local LLM Provider via OpenAI-Compatible API

## Decision

Add a `provider-local` adapter that queries any OpenAI-compatible chat completions endpoint (Ollama, LM Studio, llama.cpp, vLLM) instead of a hosted AI API.

## Why

- lets open-source users run visibility checks without a cloud API key
- supports air-gapped and privacy-sensitive deployments
- the OpenAI-compatible API is a de-facto standard across local inference runtimes, so one adapter covers many tools
- keeps the provider interface uniform: the same `validateConfig / healthcheck / executeTrackedQuery / normalizeResult` contract used by Gemini, OpenAI, and Claude

## Consequences

- local LLMs have no native web search, so citation detection is heuristic: the adapter scans the answer text for URL patterns and bare domain mentions rather than reading structured grounding metadata
- results are less reliable than cloud providers — the model may recall training-data domains rather than current web sources, and coverage will vary widely by model
- `groundingSources` and `searchQueries` are always empty for local runs; downstream UI and export consumers must tolerate this
- configuration requires `baseUrl` instead of `apiKey` — the shared `ProviderConfig` contract and settings route were updated to make `apiKey` optional and add `baseUrl`
