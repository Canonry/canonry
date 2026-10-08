import { ProviderNames, type AnchoredAnswerSpan } from '@ainyc/canonry-contracts'
import { parseJsonColumn } from '@ainyc/canonry-db'
import { extractAnchoredSpans as extractClaudeAnchoredSpans } from '@ainyc/canonry-provider-claude'
import { extractAnchoredSpans as extractGeminiAnchoredSpans } from '@ainyc/canonry-provider-gemini'
import { extractAnchoredSpans as extractOpenAIAnchoredSpans } from '@ainyc/canonry-provider-openai'
import { extractAnchoredSpans as extractPerplexityAnchoredSpans } from '@ainyc/canonry-provider-perplexity'

/**
 * The provider body inside a stored `query_snapshots.raw_response` envelope
 * (`{ model, servedModel, groundingSources, searchQueries, apiResponse }`), or
 * the parsed value itself when an older row stored the body bare.
 */
export function resolveStoredApiResponse(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  const nested = parsed.apiResponse
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }

  if (looksLikeProviderApiResponse(parsed)) {
    return parsed
  }

  return null
}

function looksLikeProviderApiResponse(value: Record<string, unknown>): boolean {
  return Array.isArray(value.output)
    || Array.isArray(value.content)
    || Array.isArray(value.candidates)
    || Array.isArray(value.choices)
}

/**
 * The answer prose a stored snapshot's provider citation structure ties to
 * each source, read by the provider package that owns that response shape
 * (OpenAI annotations, Claude citations, Gemini grounding supports, Perplexity
 * markers). Competitor auto-alias detection is the reader; the API host
 * injects this as `competitorAnswerAnchors`, since api-routes has no provider
 * dependency. Stored data only: nothing here resolves a URL. An unreadable
 * row, or a provider with no citation structure, yields no spans.
 */
export function extractStoredAnswerAnchors(provider: string, rawResponse: string | null): AnchoredAnswerSpan[] {
  if (!rawResponse) return []
  const apiResponse = resolveStoredApiResponse(parseJsonColumn<Record<string, unknown>>(rawResponse, {}))
  if (!apiResponse) return []
  try {
    switch (provider) {
      case ProviderNames.openai:
        return extractOpenAIAnchoredSpans(apiResponse)
      case ProviderNames.claude:
        return extractClaudeAnchoredSpans(apiResponse)
      case ProviderNames.gemini:
        return extractGeminiAnchoredSpans(apiResponse)
      case ProviderNames.perplexity:
        return extractPerplexityAnchoredSpans(apiResponse)
      default:
        return []
    }
  } catch {
    // A malformed stored body is no evidence, never a failed detection pass.
    return []
  }
}
