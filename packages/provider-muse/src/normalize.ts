import OpenAI from 'openai'
import {
  AI_ENGINE_SELF_DOMAINS,
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
const MUSE_SPARK_MODEL = /^muse-spark-[a-z0-9]+(?:[.-][a-z0-9]+)*$/

export function createClient(config: MuseConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || MUSE_BASE_URL,
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

function retryRequest<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, {
    maxRetries: 3,
    baseDelayMs: 1000,
    isRetryable: isRetryableHttpError,
    computeDelayMs: (_attempt, error, delay) => retryAfterDelayMs(error) ?? delay,
  })
}

export async function healthcheck(config: MuseConfig): Promise<{ ok: boolean; provider: 'muse'; message: string; model?: string }> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation
  try {
    const response = await retryRequest(() => createClient(config).responses.create({
      model: modelOf(config),
      input: 'Say "ok"',
    }))
    const answerText = reparseStoredResult(responseToRecord(response)).answerText
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
    const client = createClient(input.config)
    const response = await retryRequest(() => client.responses.create({
      model,
      input: input.query,
      tools: [tool],
      include: ['web_search_call.results'],
    }))
    const rawResponse = responseToRecord(response)
    const parsed = requireCompleteAnswer(rawResponse)
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

function requireCompleteAnswer(rawResponse: Record<string, unknown>): MuseNormalizedResult {
  const parsed = reparseStoredResult(rawResponse)
  if (rawResponse.status !== 'completed') {
    const status = typeof rawResponse.status === 'string' ? rawResponse.status : 'missing or invalid'
    throw new Error(`Meta Model API response status: ${status}`)
  }
  if (!parsed.answerText.trim()) throw new Error('Meta Model API returned no complete answer')
  return parsed
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
  const output = Array.isArray(rawResponse.output) ? rawResponse.output : null
  const emptyResult = (): MuseNormalizedResult => ({
    provider: 'muse', answerText: '', citedDomains: [], groundingSources: [], searchQueries: [], retrievalStatus: 'unknown',
  })
  if (rawResponse.status !== 'completed' || !output) return emptyResult()
  const answerParts: string[] = []
  const groundingSources: GroundingSource[] = []
  const citedDomains = new Set<string>()
  const searchQueries = new Set<string>()
  const seenUrls = new Set<string>()
  let completedSearch = false
  let failedSearch = false
  let completeAnswer = false
  let malformedOutput = false
  let refused = false

  for (const itemValue of output) {
    const item = asRecord(itemValue)
    if (!item || typeof item.type !== 'string') {
      malformedOutput = true
      continue
    }
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
    if (item.type !== 'message') continue
    if (item.status !== undefined && item.status !== 'completed') {
      malformedOutput = true
      continue
    }
    if (!Array.isArray(item.content)) {
      malformedOutput = true
      continue
    }
    for (const blockValue of item.content) {
      const block = asRecord(blockValue)
      if (!block || typeof block.type !== 'string') {
        malformedOutput = true
        continue
      }
      if (block.type === 'refusal') {
        refused = true
        continue
      }
      if (block.type !== 'output_text') continue
      if (typeof block.text !== 'string') {
        malformedOutput = true
        continue
      }
      if (block.text.trim()) completeAnswer = true
      answerParts.push(block.text)
      if (!Array.isArray(block.annotations)) continue
      for (const annotationValue of block.annotations) {
        const annotation = asRecord(annotationValue)
        if (annotation?.type !== 'url_citation' || !validCitedUrl(annotation.url)) continue
        if (seenUrls.has(annotation.url)) continue
        seenUrls.add(annotation.url)
        groundingSources.push({ uri: annotation.url, title: typeof annotation.title === 'string' ? annotation.title : '' })
        const host = hostOf(annotation.url)
        if (host && !hostMatchesAnyDomain(host, AI_ENGINE_SELF_DOMAINS.muse)) citedDomains.add(host)
      }
    }
  }

  if (malformedOutput || refused || !completeAnswer) return emptyResult()

  let retrievalStatus: RetrievalStatus = 'unknown'
  if (completedSearch) retrievalStatus = 'used'
  else if (!failedSearch) retrievalStatus = 'not-used'
  return {
    provider: 'muse',
    answerText: answerParts.join(''),
    citedDomains: [...citedDomains],
    groundingSources,
    searchQueries: [...searchQueries],
    retrievalStatus,
  }
}

export async function generateText(prompt: string, config: MuseConfig): Promise<string> {
  const validation = validateConfig(config)
  if (!validation.ok) throw new Error(`[provider-muse] ${validation.message}`)
  const client = createClient(config)
  try {
    const response = await retryRequest(() => client.responses.create({ model: modelOf(config), input: prompt }))
    return requireCompleteAnswer(responseToRecord(response)).answerText
  } catch (err: unknown) {
    throw new Error(`[provider-muse] ${describeError(err)}`)
  }
}
