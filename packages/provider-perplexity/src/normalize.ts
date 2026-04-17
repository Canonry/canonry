import OpenAI from 'openai'
import { withRetry } from './utils.js'
import type {
  PerplexityConfig,
  PerplexityHealthcheckResult,
  PerplexityNormalizedResult,
  PerplexityRawResult,
  PerplexityTrackedQueryInput,
  GroundingSource,
} from './types.js'

const DEFAULT_MODEL = 'sonar'
const BASE_URL = 'https://api.perplexity.ai'

export function validateConfig(config: PerplexityConfig): PerplexityHealthcheckResult {
  if (!config.apiKey || config.apiKey.length === 0) {
    return { ok: false, provider: 'perplexity', message: 'missing api key' }
  }
  return {
    ok: true,
    provider: 'perplexity',
    message: 'config valid',
    model: config.model ?? DEFAULT_MODEL,
  }
}

export async function healthcheck(config: PerplexityConfig): Promise<PerplexityHealthcheckResult> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation

  try {
    const client = new OpenAI({ apiKey: config.apiKey, baseURL: BASE_URL })
    const response = await withRetry(() =>
      client.chat.completions.create({
        model: config.model ?? DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'Say "ok"' }],
      }),
    )
    const text = response.choices[0]?.message?.content ?? ''
    return {
      ok: text.length > 0,
      provider: 'perplexity',
      message: text.length > 0 ? 'perplexity api key verified' : 'empty response from perplexity',
      model: config.model ?? DEFAULT_MODEL,
    }
  } catch (err: unknown) {
    return {
      ok: false,
      provider: 'perplexity',
      message: err instanceof Error ? err.message : String(err),
      model: config.model ?? DEFAULT_MODEL,
    }
  }
}

export async function executeTrackedQuery(input: PerplexityTrackedQueryInput): Promise<PerplexityRawResult> {
  const model = input.config.model ?? DEFAULT_MODEL
  const client = new OpenAI({ apiKey: input.config.apiKey, baseURL: BASE_URL })

  const prompt = buildPrompt(input.keyword, input.location)

  try {
    const response = await withRetry(() =>
      client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
      }),
    )

    const rawResponse = responseToRecord(response)
    const parsed = reparseStoredResult(rawResponse)

    return {
      provider: 'perplexity',
      rawResponse,
      model,
      groundingSources: parsed.groundingSources,
      searchQueries: parsed.searchQueries,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[provider-perplexity] ${msg}`)
  }
}

export function normalizeResult(raw: PerplexityRawResult): PerplexityNormalizedResult {
  const parsed = reparseStoredResult(raw.rawResponse)
  const useParsed = hasParsedResponseContent(raw.rawResponse)
  const groundingSources = useParsed ? parsed.groundingSources : raw.groundingSources
  const searchQueries = useParsed ? parsed.searchQueries : raw.searchQueries
  const citedDomains = extractCitedDomains(groundingSources)

  return {
    provider: 'perplexity',
    answerText: parsed.answerText,
    citedDomains,
    groundingSources,
    searchQueries,
  }
}

function hasParsedResponseContent(rawResponse: Record<string, unknown>): boolean {
  if (Array.isArray(rawResponse.choices) && rawResponse.choices.length > 0) return true
  if (Array.isArray(rawResponse.search_results) && rawResponse.search_results.length > 0) return true
  if (Array.isArray(rawResponse.citations) && rawResponse.citations.length > 0) return true
  const nestedResponse = extractNestedApiResponse(rawResponse)
  if (!nestedResponse) return false
  return (
    (Array.isArray(nestedResponse.choices) && nestedResponse.choices.length > 0)
    || (Array.isArray(nestedResponse.search_results) && nestedResponse.search_results.length > 0)
    || (Array.isArray(nestedResponse.citations) && nestedResponse.citations.length > 0)
  )
}

export function reparseStoredResult(rawResponse: Record<string, unknown>): PerplexityNormalizedResult {
  const groundingSources = extractGroundingSources(rawResponse)

  return {
    provider: 'perplexity',
    answerText: extractAnswerText(rawResponse),
    citedDomains: extractCitedDomains(groundingSources),
    groundingSources,
    // Perplexity documents `search_results` and `citations` on the response structure but
    // does not document returned search-query telemetry, so Canonry does not synthesize it.
    // Docs: https://docs.perplexity.ai/docs/sonar/openai-compatibility
    searchQueries: [],
  }
}

// --- Internal helpers ---

function buildPrompt(keyword: string, location?: PerplexityTrackedQueryInput['location']): string {
  if (location) {
    return `${keyword} (searching from ${location.city}, ${location.region}, ${location.country})`
  }
  return keyword
}

/**
 * Extract the citations array from a Perplexity response.
 *
 * Handles two shapes:
 * 1. Direct API response — `rawResponse.citations` (array of URL strings at top level)
 * 2. Stored DB format — `rawResponse.apiResponse.citations` (job-runner wraps the raw API
 *    response under an `apiResponse` key before persisting to query_snapshots.raw_response)
 *
 * Perplexity's Sonar models return citations by default; no extra flag required.
 * Docs: https://docs.perplexity.ai/docs/sonar/openai-compatibility
 */
export function extractCitations(rawResponse: Record<string, unknown>): string[] {
  // Shape 1: direct API response (used at execution time)
  if (Array.isArray(rawResponse.citations)) {
    return rawResponse.citations.filter((c): c is string => typeof c === 'string')
  }
  // Shape 2: stored DB format — citations nested under apiResponse
  const nestedResponse = extractNestedApiResponse(rawResponse)
  if (nestedResponse) {
    const nested = nestedResponse.citations
    if (Array.isArray(nested)) {
      return nested.filter((c): c is string => typeof c === 'string')
    }
  }
  return []
}

function extractGroundingSources(rawResponse: Record<string, unknown>): GroundingSource[] {
  // Perplexity's documented response structure exposes `search_results` as the richer source
  // metadata and `citations` as the cited URL list, so prefer `search_results` when present.
  // Docs: https://docs.perplexity.ai/docs/sonar/openai-compatibility
  const searchResults = extractSearchResults(rawResponse)
  if (searchResults.length > 0) {
    const seen = new Set<string>()
    const sources: GroundingSource[] = []
    for (const result of searchResults) {
      if (seen.has(result.uri)) continue
      seen.add(result.uri)
      sources.push(result)
    }
    return sources
  }

  return extractCitations(rawResponse).map((url) => ({
    uri: url,
    title: '',
  }))
}

function extractSearchResults(rawResponse: Record<string, unknown>): GroundingSource[] {
  const direct = parseSearchResultsArray(rawResponse.search_results)
  if (direct.length > 0) return direct

  const nestedResponse = extractNestedApiResponse(rawResponse)
  if (nestedResponse) {
    return parseSearchResultsArray(nestedResponse.search_results)
  }

  return []
}

function parseSearchResultsArray(value: unknown): GroundingSource[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((result) => {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return []
    }
    const url = (result as Record<string, unknown>).url
    if (typeof url !== 'string' || url.length === 0) {
      return []
    }
    const title = (result as Record<string, unknown>).title
    return [{
      uri: url,
      title: typeof title === 'string' ? title : '',
    }]
  })
}

function extractAnswerText(rawResponse: Record<string, unknown>): string {
  try {
    const directChoices = rawResponse.choices as Array<{
      message?: { content?: string }
    }> | undefined
    if (directChoices?.length) {
      return directChoices[0].message?.content ?? ''
    }

    const nestedResponse = extractNestedApiResponse(rawResponse)
    const nestedChoices = nestedResponse?.choices as Array<{
      message?: { content?: string }
    }> | undefined
    if (!nestedChoices?.length) return ''
    return nestedChoices[0].message?.content ?? ''
  } catch {
    return ''
  }
}

function extractNestedApiResponse(rawResponse: Record<string, unknown>): Record<string, unknown> | null {
  const apiResponse = rawResponse.apiResponse
  if (apiResponse !== null && typeof apiResponse === 'object' && !Array.isArray(apiResponse)) {
    return apiResponse as Record<string, unknown>
  }
  return null
}

export function extractCitedDomains(groundingSources: GroundingSource[]): string[] {
  const domains = new Set<string>()
  for (const source of groundingSources) {
    const domain = extractDomainFromUri(source.uri)
    if (domain) domains.add(domain)
  }
  return [...domains]
}

function extractDomainFromUri(uri: string): string | null {
  try {
    const url = new URL(uri)
    const hostname = url.hostname.replace(/^www\./, '').toLowerCase()
    // Skip internal AI service domains
    if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) {
      return null
    }
    return hostname
  } catch {
    return null
  }
}

export async function generateText(prompt: string, config: PerplexityConfig): Promise<string> {
  const model = config.model ?? DEFAULT_MODEL
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: BASE_URL })
  const response = await withRetry(() =>
    client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  )
  return response.choices[0]?.message?.content ?? ''
}

function responseToRecord(response: OpenAI.Chat.Completions.ChatCompletion): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(response)) as Record<string, unknown>
  } catch {
    return { error: 'failed to serialize response' }
  }
}
