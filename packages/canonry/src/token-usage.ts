/**
 * Token-cost telemetry extractor (Track 1 — Canonry Hosted).
 *
 * Each provider exposes a slightly different shape for the usage block on
 * its raw API response. This module is a pure mapping from a stored
 * `query_snapshots.raw_response` JSON to a normalized `{ inputTokens,
 * outputTokens, cachedInputTokens }` triple. Called from `RunCoordinator`
 * on every `run.completed` to persist a row into `provider_token_usage`.
 *
 * Returns `null` when the response doesn't carry a usage block (e.g. CDP /
 * browser providers, or older snapshots from before instrumentation
 * shipped). Callers should skip persistence in that case rather than
 * writing zero rows that would dilute downstream cost dashboards.
 *
 * Provider documentation references:
 *   • Anthropic: https://platform.claude.com/docs/en/build-with-claude/token-counting
 *   • OpenAI:    https://platform.openai.com/docs/api-reference/responses/object
 *   • Gemini:    https://ai.google.dev/api/generate-content#usagemetadata
 *   • Perplexity: https://docs.perplexity.ai/api-reference/chat-completions-post
 */

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

type RawObject = Record<string, unknown>

function asObject(value: unknown): RawObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as RawObject
}

function asInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/**
 * Find the provider-native API response inside the stored snapshot wrapper.
 *
 * `JobRunner` wraps each provider response under `{ model, groundingSources,
 * searchQueries, apiResponse: ... }` before storing it in
 * `query_snapshots.raw_response`. The provider's own usage block lives on
 * `apiResponse`. When the wrapper is absent (older rows, direct stores),
 * fall back to the top-level object.
 */
function unwrapApiResponse(raw: RawObject): RawObject {
  const nested = asObject(raw.apiResponse)
  return nested ?? raw
}

function extractAnthropicUsage(api: RawObject): TokenUsage | null {
  const usage = asObject(api.usage)
  if (!usage) return null
  return {
    inputTokens: asInt(usage.input_tokens),
    outputTokens: asInt(usage.output_tokens),
    // Anthropic exposes both `cache_read_input_tokens` (paid 90% discount)
    // and `cache_creation_input_tokens` (initial cache write at full price).
    // The proxy treats the cache-read count as the "cached" surface so
    // billing dashboards can credit the discount. Cache-creation tokens
    // remain in `inputTokens` since they're charged at full price.
    cachedInputTokens: asInt(usage.cache_read_input_tokens),
  }
}

function extractOpenAIUsage(api: RawObject): TokenUsage | null {
  const usage = asObject(api.usage)
  if (!usage) return null

  // The Responses API uses `input_tokens` / `output_tokens` (rename of the
  // older `prompt_tokens` / `completion_tokens`). Accept either so the same
  // extractor works against stored snapshots regardless of when they were
  // written. https://platform.openai.com/docs/api-reference/responses/object
  const input = asInt(usage.input_tokens) || asInt(usage.prompt_tokens)
  const output = asInt(usage.output_tokens) || asInt(usage.completion_tokens)

  // Cached tokens surface on the prompt-side details object in both APIs.
  const inputDetails = asObject(usage.input_tokens_details) ?? asObject(usage.prompt_tokens_details)
  const cached = inputDetails ? asInt(inputDetails.cached_tokens) : 0

  if (input === 0 && output === 0) return null
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached }
}

function extractGeminiUsage(api: RawObject): TokenUsage | null {
  const metadata = asObject(api.usageMetadata)
  if (!metadata) return null
  const input = asInt(metadata.promptTokenCount)
  const output = asInt(metadata.candidatesTokenCount)
  // Gemini exposes a `cachedContentTokenCount` field for grounded prompts;
  // older payloads omit it entirely.
  const cached = asInt(metadata.cachedContentTokenCount)

  if (input === 0 && output === 0) return null
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached }
}

function extractPerplexityUsage(api: RawObject): TokenUsage | null {
  // Perplexity returns OpenAI-compatible usage on chat.completions.
  const usage = asObject(api.usage)
  if (!usage) return null
  const input = asInt(usage.prompt_tokens) || asInt(usage.input_tokens)
  const output = asInt(usage.completion_tokens) || asInt(usage.output_tokens)
  if (input === 0 && output === 0) return null
  return { inputTokens: input, outputTokens: output, cachedInputTokens: 0 }
}

/**
 * Extract usage from a stored `query_snapshots.raw_response`.
 *
 * @param provider The adapter name (`'openai'` / `'claude'` / `'gemini'` /
 *                 `'perplexity'` / `'local'` / `'cdp:...'`).
 * @param rawJson  The string blob written by `JobRunner` (or a pre-parsed
 *                 object, for unit tests).
 * @returns null when no usage block is found — callers MUST skip persistence
 *          rather than writing zero-counter rows.
 */
export function extractTokenUsage(provider: string, rawJson: string | RawObject): TokenUsage | null {
  let parsed: RawObject | null
  if (typeof rawJson === 'string') {
    try {
      const data = JSON.parse(rawJson) as unknown
      parsed = asObject(data)
    } catch {
      return null
    }
  } else {
    parsed = asObject(rawJson)
  }
  if (!parsed) return null

  const api = unwrapApiResponse(parsed)

  switch (provider) {
    case 'claude':
      return extractAnthropicUsage(api)
    case 'openai':
      return extractOpenAIUsage(api)
    case 'gemini':
      return extractGeminiUsage(api)
    case 'perplexity':
      return extractPerplexityUsage(api)
    default:
      // CDP / browser providers, custom local providers, future adapters —
      // no documented usage shape yet, so we skip rather than guess.
      return null
  }
}
