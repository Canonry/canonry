import OpenAI from 'openai'
import {
  AI_ENGINE_DOMAINS,
  asRecord,
  describeError,
  hostMatchesAnyDomain,
  hostOf,
  isRetryableHttpError,
  normalizeServedModel,
  registrableDomain,
  retryAfterDelayMs,
  withRetry,
  type GroundingSource,
  type RetrievalStatus,
} from '@ainyc/canonry-contracts'
import type { MuseConfig, MuseNormalizedResult, MuseRawResult, MuseTrackedQueryInput } from './types.js'

export const MUSE_DEFAULT_MODEL = 'muse-spark-1.3'
export const MUSE_BASE_URL = 'https://api.meta.ai/v1'
export const MUSE_SPARK_MODEL = /^muse-spark-[a-z0-9]+(?:[.-][a-z0-9]+)*$/
// Kept out of the shared AI_ENGINE_SELF_DOMAINS: an entry there also drops
// these hosts from every other provider's cited URLs.
const MUSE_SELF_DOMAINS: readonly string[] = [AI_ENGINE_DOMAINS.metaAi]
// A longer Retry-After would park the call inside the shared provider gate.
const MAX_RETRY_AFTER_MS = 60_000
const RETRYABLE_RESPONSE_ERROR_CODES = new Set(['rate_limit_exceeded', 'server_error'])

export function createClient(config: MuseConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || MUSE_BASE_URL,
    // Otherwise the SDK sends OPENAI_ORG_ID / OPENAI_PROJECT_ID to Meta.
    organization: null,
    project: null,
    maxRetries: 0,
  })
}

function modelOf(config: MuseConfig): string {
  return config.model || MUSE_DEFAULT_MODEL
}

export function validateConfig(config: MuseConfig): { ok: boolean; provider: 'muse'; message: string; model?: string } {
  if (!config.apiKey.trim()) return { ok: false, provider: 'muse', message: 'missing api key' }
  const model = modelOf(config)
  if (!MUSE_SPARK_MODEL.test(model)) {
    return { ok: false, provider: 'muse', message: 'model must be a Muse Spark text model' }
  }
  return { ok: true, provider: 'muse', message: 'config valid', model }
}

/** A 200 body that reports its own failure; its error code decides whether a retry can help. */
class MuseResponseError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'MuseResponseError'
  }
}

function retryRequest<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, {
    maxRetries: 3,
    baseDelayMs: 1000,
    isRetryable: error => error instanceof MuseResponseError ? error.retryable : isRetryableHttpError(error),
    computeDelayMs: (_attempt, error, delay) => {
      const retryDelay = retryAfterDelayMs(error) ?? delay
      if (retryDelay > MAX_RETRY_AFTER_MS) throw error
      return retryDelay
    },
  })
}

function statusMessage(rawResponse: Record<string, unknown>): string {
  const status = typeof rawResponse.status === 'string' ? rawResponse.status : 'missing or invalid'
  const error = asRecord(rawResponse.error)
  const detail = [error?.code, error?.message, asRecord(rawResponse.incomplete_details)?.reason]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(': ')
  return `Meta Model API response status: ${status}${detail ? ` (${detail})` : ''}`
}

/**
 * One Responses call, retried as a unit so a throttle reported in a 200 body
 * backs off like an HTTP 429. `completed` and `incomplete` bodies carry an
 * answer to record; any other status fails the call.
 */
function createResponse(
  config: MuseConfig,
  body: OpenAI.Responses.ResponseCreateParamsNonStreaming,
): Promise<Record<string, unknown>> {
  const client = createClient(config)
  return retryRequest(async () => {
    const rawResponse = responseToRecord(await client.responses.create(body))
    if (rawResponse.status !== 'completed' && rawResponse.status !== 'incomplete') {
      const code = asRecord(rawResponse.error)?.code
      throw new MuseResponseError(
        statusMessage(rawResponse),
        typeof code === 'string' && RETRYABLE_RESPONSE_ERROR_CODES.has(code),
      )
    }
    return rawResponse
  })
}

export async function healthcheck(config: MuseConfig): Promise<{ ok: boolean; provider: 'muse'; message: string; model?: string }> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation
  try {
    const rawResponse = await createResponse(config, { model: modelOf(config), input: 'Say "ok"' })
    const answerText = reparseStoredResult(rawResponse).answerText
    return {
      ok: answerText.length > 0,
      provider: 'muse',
      message: answerText.length > 0 ? 'muse api key verified' : 'empty response from muse',
      model: modelOf(config),
    }
  } catch (err: unknown) {
    return { ok: false, provider: 'muse', message: describeError(err), model: modelOf(config) }
  }
}

export async function executeTrackedQuery(input: MuseTrackedQueryInput): Promise<MuseRawResult> {
  const validation = validateConfig(input.config)
  if (!validation.ok) throw new Error(`[provider-muse] ${validation.message}`)
  const model = modelOf(input.config)
  const tool: OpenAI.Responses.WebSearchTool = { type: 'web_search' }
  if (input.location) {
    tool.user_location = {
      type: 'approximate',
      ...(input.location.city ? { city: input.location.city } : {}),
      ...(input.location.region ? { region: input.location.region } : {}),
      ...(input.location.country ? { country: input.location.country } : {}),
      ...(input.location.timezone ? { timezone: input.location.timezone } : {}),
    }
  }
  try {
    const rawResponse = await createResponse(input.config, { model, input: input.query, tools: [tool] })
    const parsed = parseResponse(rawResponse)
    if (!parsed) throw new Error('Meta Model API returned a malformed response')
    return {
      provider: 'muse',
      rawResponse,
      model,
      servedModel: extractServedModel(rawResponse),
      groundingSources: parsed.groundingSources,
      searchQueries: parsed.searchQueries,
      retrievalStatus: parsed.retrievalStatus,
    }
  } catch (err: unknown) {
    throw new Error(`[provider-muse] ${describeError(err)}`)
  }
}

export function extractServedModel(rawResponse: Record<string, unknown>): string | undefined {
  return normalizeServedModel(rawResponse.model)
}

export function normalizeResult(raw: MuseRawResult): MuseNormalizedResult {
  return reparseStoredResult(raw.rawResponse)
}

function validCitedUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && Boolean(hostOf(value)) && Boolean(registrableDomain(value))
  } catch {
    return false
  }
}

function responseToRecord(response: OpenAI.Responses.Response): Record<string, unknown> {
  return JSON.parse(JSON.stringify(response)) as Record<string, unknown>
}

export function reparseStoredResult(rawResponse: Record<string, unknown>): MuseNormalizedResult {
  return parseResponse(rawResponse) ?? {
    provider: 'muse', answerText: '', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'unknown',
  }
}

/**
 * Parse an intact `completed` or `incomplete` body, or return null. A refused
 * or truncated answer is still an observation: its text and citations count
 * as they stand. Commentary messages narrate the model's work and are not
 * part of the answer.
 */
function parseResponse(rawResponse: Record<string, unknown>): MuseNormalizedResult | null {
  const output = Array.isArray(rawResponse.output) ? rawResponse.output : null
  if ((rawResponse.status !== 'completed' && rawResponse.status !== 'incomplete') || !output) return null
  const messageTexts: string[] = []
  const groundingSources: GroundingSource[] = []
  const citedDomains = new Set<string>()
  const searchQueries = new Set<string>()
  const seenUrls = new Set<string>()
  let completedSearch = false
  let failedSearch = false

  for (const itemValue of output) {
    const item = asRecord(itemValue)
    if (!item || typeof item.type !== 'string') return null
    if (item.type === 'web_search_call') {
      if (item.status === 'completed') completedSearch = true
      else failedSearch = true
      const action = asRecord(item.action)
      if (typeof action?.query === 'string' && action.query) searchQueries.add(action.query)
      if (Array.isArray(action?.queries)) {
        for (const query of action.queries) {
          if (typeof query === 'string' && query) searchQueries.add(query)
        }
      }
      continue
    }
    if (item.type !== 'message' || item.phase === 'commentary') continue
    if (item.status !== undefined && item.status !== 'completed' && item.status !== 'incomplete') return null
    if (!Array.isArray(item.content)) return null
    const blockTexts: string[] = []
    for (const blockValue of item.content) {
      const block = asRecord(blockValue)
      if (!block || typeof block.type !== 'string') return null
      if (block.type !== 'output_text') continue
      if (typeof block.text !== 'string') return null
      blockTexts.push(block.text)
      if (!Array.isArray(block.annotations)) continue
      for (const annotationValue of block.annotations) {
        const annotation = asRecord(annotationValue)
        if (annotation?.type !== 'url_citation' || !validCitedUrl(annotation.url)) continue
        if (seenUrls.has(annotation.url)) continue
        seenUrls.add(annotation.url)
        groundingSources.push({ uri: annotation.url, title: typeof annotation.title === 'string' ? annotation.title : '' })
        const host = hostOf(annotation.url)
        if (host && !hostMatchesAnyDomain(host, MUSE_SELF_DOMAINS)) citedDomains.add(host)
      }
    }
    const messageText = blockTexts.join('')
    if (messageText.trim()) messageTexts.push(messageText)
  }

  const answerText = messageTexts.join('\n\n')
  let retrievalStatus: RetrievalStatus = 'unknown'
  if (answerText) {
    if (completedSearch) retrievalStatus = 'used'
    else if (!failedSearch) retrievalStatus = 'not-used'
  }
  return {
    provider: 'muse',
    answerText,
    citedDomains: [...citedDomains],
    groundingSources,
    searchQueries: [...searchQueries],
    retrievalStatus,
  }
}

export async function generateText(prompt: string, config: MuseConfig): Promise<string> {
  const validation = validateConfig(config)
  if (!validation.ok) throw new Error(`[provider-muse] ${validation.message}`)
  try {
    const rawResponse = await createResponse(config, { model: modelOf(config), input: prompt })
    // Generated text is consumed whole, so a truncated answer fails here.
    if (rawResponse.status !== 'completed') throw new Error(statusMessage(rawResponse))
    const answerText = reparseStoredResult(rawResponse).answerText
    if (!answerText) throw new Error('Meta Model API returned no answer text')
    return answerText
  } catch (err: unknown) {
    throw new Error(`[provider-muse] ${describeError(err)}`)
  }
}
