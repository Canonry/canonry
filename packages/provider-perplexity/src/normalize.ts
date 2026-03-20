import OpenAI from 'openai'
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
    const response = await client.chat.completions.create({
      model: config.model ?? DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'Say "ok"' }],
    })
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

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'user', content: input.keyword },
    ],
  })

  const rawResponse = responseToRecord(response)

  // Perplexity returns citations as a top-level array on the response
  const citations = extractCitations(rawResponse)
  const groundingSources = citations.map(url => ({
    uri: url,
    title: '',
  }))

  return {
    provider: 'perplexity',
    rawResponse,
    model,
    groundingSources,
    searchQueries: [input.keyword],
  }
}

export function normalizeResult(raw: PerplexityRawResult): PerplexityNormalizedResult {
  const answerText = extractAnswerText(raw.rawResponse)
  const citedDomains = extractCitedDomains(raw.groundingSources)

  return {
    provider: 'perplexity',
    answerText,
    citedDomains,
    groundingSources: raw.groundingSources,
    searchQueries: raw.searchQueries,
  }
}

// --- Internal helpers ---

/**
 * Extract the citations array from a Perplexity response.
 *
 * Handles two shapes:
 * 1. Direct API response — `rawResponse.citations` (array of URL strings at top level)
 * 2. Stored DB format — `rawResponse.apiResponse.citations` (job-runner wraps the raw API
 *    response under an `apiResponse` key before persisting to query_snapshots.raw_response)
 *
 * Perplexity's Sonar models return citations by default; no extra flag required.
 */
export function extractCitations(rawResponse: Record<string, unknown>): string[] {
  // Shape 1: direct API response (used at execution time)
  if (Array.isArray(rawResponse.citations)) {
    return rawResponse.citations.filter((c): c is string => typeof c === 'string')
  }
  // Shape 2: stored DB format — citations nested under apiResponse
  const apiResponse = rawResponse.apiResponse
  if (apiResponse !== null && typeof apiResponse === 'object' && !Array.isArray(apiResponse)) {
    const nested = (apiResponse as Record<string, unknown>).citations
    if (Array.isArray(nested)) {
      return nested.filter((c): c is string => typeof c === 'string')
    }
  }
  return []
}

function extractAnswerText(rawResponse: Record<string, unknown>): string {
  try {
    const choices = rawResponse.choices as Array<{
      message?: { content?: string }
    }> | undefined
    if (!choices?.length) return ''
    return choices[0].message?.content ?? ''
  } catch {
    return ''
  }
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
    return url.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export async function generateText(prompt: string, config: PerplexityConfig): Promise<string> {
  const model = config.model ?? DEFAULT_MODEL
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: BASE_URL })
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
  })
  return response.choices[0]?.message?.content ?? ''
}

function responseToRecord(response: OpenAI.Chat.Completions.ChatCompletion): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(response)) as Record<string, unknown>
  } catch {
    return { error: 'failed to serialize response' }
  }
}
