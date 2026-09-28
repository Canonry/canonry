import OpenAI from 'openai'
import { hostOf, normalizeServedModel, registrableDomain, describeError, usageCount } from '@ainyc/canonry-contracts'
import type { ProviderUsage, TrackedQueryRequest } from '@ainyc/canonry-contracts'
import { withRetry } from './utils.js'
import type {
  GroundingSource,
  LocalConfig,
  LocalHealthcheckResult,
  LocalNormalizedResult,
  LocalRawResult,
  LocalTrackedQueryInput,
} from './types.js'

const DEFAULT_MODEL = 'llama3'

export function validateConfig(config: LocalConfig): LocalHealthcheckResult {
  if (!config.baseUrl || config.baseUrl.length === 0) {
    return { ok: false, provider: 'local', message: 'missing base URL' }
  }
  return {
    ok: true,
    provider: 'local',
    message: 'config valid',
    model: config.model ?? DEFAULT_MODEL,
  }
}

export async function healthcheck(config: LocalConfig): Promise<LocalHealthcheckResult> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation

  try {
    const client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'not-needed',
    })
    const models = await withRetry(async () => {
      const list = await client.models.list()
      const items = []
      for await (const m of list) {
        items.push(m.id)
        if (items.length >= 5) break
      }
      return items
    })
    return {
      ok: true,
      provider: 'local',
      message: `connected, ${models.length} model(s) available`,
      model: config.model ?? DEFAULT_MODEL,
    }
  } catch (err: unknown) {
    return {
      ok: false,
      provider: 'local',
      message: describeError(err),
      model: config.model ?? DEFAULT_MODEL,
    }
  }
}

/** The chat completions path a tracked query is sent to, relative to the configured base URL. */
export const LOCAL_CHAT_COMPLETIONS_ENDPOINT = '/chat/completions'

/** The first half of `executeTrackedQuery`: the exact chat completion request it sends. */
export function buildTrackedQueryRequest(input: LocalTrackedQueryInput): TrackedQueryRequest {
  const body = {
    model: input.config.model ?? DEFAULT_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant. Provide comprehensive, factual answers. When mentioning websites or services, include their domain names.',
      },
      {
        role: 'user',
        content: buildPrompt(input.query, input.location),
      },
    ],
  } satisfies OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming

  return { endpoint: LOCAL_CHAT_COMPLETIONS_ENDPOINT, body }
}

export async function executeTrackedQuery(input: LocalTrackedQueryInput): Promise<LocalRawResult> {
  const model = input.config.model ?? DEFAULT_MODEL
  const params = buildTrackedQueryRequest(input).body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
  const client = new OpenAI({
    baseURL: input.config.baseUrl,
    apiKey: input.config.apiKey || 'not-needed',
  })

  let response: OpenAI.Chat.Completions.ChatCompletion
  try {
    response = await withRetry(() => client.chat.completions.create(params))
  } catch (err: unknown) {
    const msg = describeError(err)
    throw new Error(`[provider-local] ${msg}`)
  }
  return parseTrackedQueryResponse(response, model)
}

/**
 * The second half of `executeTrackedQuery`: read one chat completion (the
 * SDK's object, or the same completion as JSON) into a result. `model` is the
 * model the request asked for. A local model has no web access, so there are
 * no grounding sources or search queries to read.
 */
export function parseTrackedQueryResponse(body: object, model: string): LocalRawResult {
  const rawResponse = responseToRecord(body)

  return {
    provider: 'local',
    rawResponse,
    model,
    servedModel: extractServedModel(rawResponse),
    groundingSources: [],
    searchQueries: [],
    usage: extractUsageFromRaw(rawResponse),
    stopReason: extractStopReasonFromRaw(rawResponse),
  }
}

export function normalizeResult(raw: LocalRawResult): LocalNormalizedResult {
  const answerText = extractAnswerText(raw.rawResponse)
  const groundingSources: GroundingSource[] = raw.groundingSources
  const citedDomains = [...new Set(
    groundingSources
      .map(source => hostOf(source.uri))
      .filter((domain): domain is string => domain !== null && registrableDomain(domain).length > 0),
  )]

  return {
    provider: 'local',
    answerText,
    citedDomains,
    groundingSources,
    searchQueries: raw.searchQueries,
  }
}

// --- Internal helpers ---

function buildPrompt(query: string, location?: import('./types.js').LocalTrackedQueryInput['location']): string {
  const locationContext = location ? ` The user is searching from ${location.city}, ${location.region}, ${location.country}.` : ''
  return `Based on your training knowledge, what websites, services, or organizations are commonly associated with "${query}"?${locationContext} List the most relevant ones and include their domain names (e.g. example.com) where you know them.`
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

export async function generateText(prompt: string, config: LocalConfig): Promise<string> {
  const model = config.model ?? DEFAULT_MODEL
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey || 'not-needed',
  })
  const response = await withRetry(() =>
    client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  )
  return response.choices[0]?.message?.content ?? ''
}

/**
 * Read the model the local server reported serving off a stored raw response. A
 * response that omits `model` yields undefined rather than the configured model —
 * local servers routinely echo back a different tag than the one requested.
 */
export function extractServedModel(rawResponse: Record<string, unknown>): string | undefined {
  return normalizeServedModel(rawResponse.model)
}

/**
 * Tokens off the OpenAI-compatible `usage` object, when the runtime reports
 * one. There is no web search, so `searchCount` is 0. A runtime that reports
 * no usage yields undefined, never a zero-cost answer.
 */
function extractUsageFromRaw(rawResponse: Record<string, unknown>): ProviderUsage | undefined {
  const usage = rawResponse.usage as {
    prompt_tokens?: unknown
    prompt_tokens_details?: { cached_tokens?: unknown } | null
    completion_tokens?: unknown
  } | null | undefined
  if (usage === null || typeof usage !== 'object') return undefined

  const promptTokens = usageCount(usage.prompt_tokens)
  const cachedInputTokens = usageCount(usage.prompt_tokens_details?.cached_tokens)
  return {
    inputTokens: Math.max(0, promptTokens - cachedInputTokens),
    cachedInputTokens,
    cacheWriteTokens: 0,
    outputTokens: usageCount(usage.completion_tokens),
    searchCount: 0,
  }
}

/** `choices[0].finish_reason` verbatim (`stop`, `length`, …). */
function extractStopReasonFromRaw(rawResponse: Record<string, unknown>): string | undefined {
  const choices = rawResponse.choices as Array<{ finish_reason?: unknown } | null> | undefined
  const finishReason = Array.isArray(choices) ? choices[0]?.finish_reason : undefined
  return typeof finishReason === 'string' && finishReason.length > 0 ? finishReason : undefined
}

/** Detach a response into plain JSON, the shape stored as `apiResponse`. */
function responseToRecord(response: object): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(response)) as Record<string, unknown>
  } catch {
    return { error: 'failed to serialize response' }
  }
}
