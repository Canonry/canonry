import { describe, it, expect } from 'vitest'
import { extractTokenUsage } from '../src/token-usage.js'

describe('extractTokenUsage', () => {
  // Each adapter wraps its provider response under
  //   { model, groundingSources, searchQueries, apiResponse: <native shape> }
  // before storing it in `query_snapshots.raw_response`. The extractor must
  // unwrap that envelope before reading the provider-specific usage block.

  describe('Anthropic / Claude', () => {
    it('reads usage.input_tokens / output_tokens / cache_read_input_tokens', () => {
      const stored = {
        model: 'claude-sonnet-4-6',
        groundingSources: [],
        searchQueries: [],
        apiResponse: {
          id: 'msg_xxx',
          content: [],
          usage: {
            input_tokens: 1200,
            output_tokens: 300,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 100,
          },
        },
      }
      expect(extractTokenUsage('claude', JSON.stringify(stored))).toEqual({
        inputTokens: 1200,
        outputTokens: 300,
        cachedInputTokens: 100,
      })
    })

    it('defaults cachedInputTokens to 0 when cache_read_input_tokens is absent', () => {
      const stored = {
        apiResponse: { usage: { input_tokens: 50, output_tokens: 10 } },
      }
      expect(extractTokenUsage('claude', stored)).toEqual({
        inputTokens: 50,
        outputTokens: 10,
        cachedInputTokens: 0,
      })
    })

    it('returns null when the response has no usage block', () => {
      expect(extractTokenUsage('claude', { apiResponse: { content: [] } })).toBeNull()
    })
  })

  describe('OpenAI', () => {
    it('reads usage.input_tokens / output_tokens on Responses API payloads', () => {
      const stored = {
        apiResponse: {
          output: [],
          usage: {
            input_tokens: 800,
            output_tokens: 150,
            input_tokens_details: { cached_tokens: 200 },
          },
        },
      }
      expect(extractTokenUsage('openai', stored)).toEqual({
        inputTokens: 800,
        outputTokens: 150,
        cachedInputTokens: 200,
      })
    })

    it('accepts legacy usage.prompt_tokens / completion_tokens shape', () => {
      const stored = {
        apiResponse: {
          usage: {
            prompt_tokens: 60,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 12 },
          },
        },
      }
      expect(extractTokenUsage('openai', stored)).toEqual({
        inputTokens: 60,
        outputTokens: 40,
        cachedInputTokens: 12,
      })
    })

    it('returns null when both counters are zero/absent', () => {
      expect(extractTokenUsage('openai', { apiResponse: { usage: {} } })).toBeNull()
    })
  })

  describe('Gemini', () => {
    it('reads usageMetadata.promptTokenCount / candidatesTokenCount / cachedContentTokenCount', () => {
      const stored = {
        apiResponse: {
          candidates: [],
          usageMetadata: {
            promptTokenCount: 500,
            candidatesTokenCount: 75,
            cachedContentTokenCount: 40,
            totalTokenCount: 575,
          },
        },
      }
      expect(extractTokenUsage('gemini', stored)).toEqual({
        inputTokens: 500,
        outputTokens: 75,
        cachedInputTokens: 40,
      })
    })

    it('handles missing cachedContentTokenCount', () => {
      const stored = {
        apiResponse: {
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      }
      expect(extractTokenUsage('gemini', stored)).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
      })
    })

    it('returns null when usageMetadata is missing entirely', () => {
      expect(extractTokenUsage('gemini', { apiResponse: { candidates: [] } })).toBeNull()
    })
  })

  describe('Perplexity', () => {
    it('reads OpenAI-compatible usage.prompt_tokens / completion_tokens', () => {
      const stored = {
        apiResponse: {
          choices: [],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 120,
            total_tokens: 200,
          },
        },
      }
      expect(extractTokenUsage('perplexity', stored)).toEqual({
        inputTokens: 80,
        outputTokens: 120,
        cachedInputTokens: 0,
      })
    })

    it('returns null when usage block is missing', () => {
      expect(extractTokenUsage('perplexity', { apiResponse: { choices: [] } })).toBeNull()
    })
  })

  describe('unrecognized providers', () => {
    it('returns null for browser/CDP providers (no documented usage shape)', () => {
      expect(extractTokenUsage('cdp:chatgpt', { apiResponse: { usage: { input_tokens: 1 } } }))
        .toBeNull()
    })

    it('returns null for local provider snapshots', () => {
      expect(extractTokenUsage('local', { apiResponse: { usage: { input_tokens: 1 } } }))
        .toBeNull()
    })
  })

  describe('robustness', () => {
    it('returns null for invalid JSON strings', () => {
      expect(extractTokenUsage('claude', 'not-json')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(extractTokenUsage('claude', '')).toBeNull()
    })

    it('clamps negative numbers to 0 (defensive)', () => {
      // Shouldn't ever happen in practice but guard against weird upstream
      // payloads — billing dashboards rely on non-negative counts.
      const stored = {
        apiResponse: { usage: { input_tokens: -10, output_tokens: 5 } },
      }
      expect(extractTokenUsage('claude', stored)).toEqual({
        inputTokens: 0,
        outputTokens: 5,
        cachedInputTokens: 0,
      })
    })

    it('truncates fractional token counts to integers', () => {
      const stored = {
        apiResponse: { usage: { input_tokens: 12.7, output_tokens: 3.9 } },
      }
      expect(extractTokenUsage('claude', stored)).toEqual({
        inputTokens: 12,
        outputTokens: 3,
        cachedInputTokens: 0,
      })
    })

    it('unwraps the apiResponse envelope (canonry storage shape)', () => {
      // Anthropic's raw API response is what callers see if they hit
      // anthropic.com directly. canonry wraps it in {apiResponse: ...}.
      // The extractor must handle both shapes — unwrapped (direct API
      // response) and wrapped (stored snapshot).
      const direct = { usage: { input_tokens: 1, output_tokens: 2 } }
      const wrapped = { apiResponse: direct }
      expect(extractTokenUsage('claude', direct)).toEqual({
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: 0,
      })
      expect(extractTokenUsage('claude', wrapped)).toEqual({
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: 0,
      })
    })
  })
})
