import OpenAI from 'openai'
import {
  AI_ENGINE_SELF_DOMAINS,
  hostMatchesAnyDomain,
  hostOf,
  normalizeServedModel,
  registrableDomain,
  describeError,
  usageCount,
} from '@ainyc/canonry-contracts'
import type { ProviderUsage, TrackedQueryRequest } from '@ainyc/canonry-contracts'
import { withRetry } from './utils.js'
import type {
  OpenAIConfig,
  OpenAIHealthcheckResult,
  OpenAINormalizedResult,
  OpenAIRawResult,
  OpenAITrackedQueryInput,
  GroundingSource,
} from './types.js'

const DEFAULT_MODEL = 'gpt-5.4'

/**
 * Construct the OpenAI SDK client, threading a configured `baseUrl` (e.g. a
 * proxy in front of the API) into the SDK's `baseURL`. When unset, the SDK
 * falls back to its default endpoint.
 */
export function createClient(config: OpenAIConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  })
}

export function validateConfig(config: OpenAIConfig): OpenAIHealthcheckResult {
  if (!config.apiKey || config.apiKey.length === 0) {
    return { ok: false, provider: 'openai', message: 'missing api key' }
  }
  return {
    ok: true,
    provider: 'openai',
    message: 'config valid',
    model: config.model ?? DEFAULT_MODEL,
  }
}

export async function healthcheck(config: OpenAIConfig): Promise<OpenAIHealthcheckResult> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation

  try {
    const client = createClient(config)
    const response = await withRetry(() =>
      client.responses.create({
        model: config.model ?? DEFAULT_MODEL,
        input: 'Say "ok"',
      }),
    )
    const text = extractResponseText(response)
    return {
      ok: text.length > 0,
      provider: 'openai',
      message: text.length > 0 ? 'openai api key verified' : 'empty response from openai',
      model: config.model ?? DEFAULT_MODEL,
    }
  } catch (err: unknown) {
    return {
      ok: false,
      provider: 'openai',
      message: describeError(err),
      model: config.model ?? DEFAULT_MODEL,
    }
  }
}

/** The Responses API path a tracked query is sent to, relative to the API host. */
export const OPENAI_RESPONSES_ENDPOINT = '/v1/responses'

/**
 * The first half of `executeTrackedQuery`: the exact Responses API request
 * it sends, so a batch line can ask the identical question.
 */
export function buildTrackedQueryRequest(input: OpenAITrackedQueryInput): TrackedQueryRequest {
  const webSearchTool: Record<string, unknown> = { type: 'web_search' }
  if (input.location) {
    webSearchTool.user_location = {
      type: 'approximate',
      city: input.location.city,
      region: input.location.region,
      country: input.location.country,
      ...(input.location.timezone ? { timezone: input.location.timezone } : {}),
    }
  }

  const body = {
    model: input.config.model ?? DEFAULT_MODEL,
    tools: [webSearchTool as { type: 'web_search' }],
    tool_choice: 'required',
    input: buildPrompt(input.query),
  } satisfies OpenAI.Responses.ResponseCreateParamsNonStreaming

  return { endpoint: OPENAI_RESPONSES_ENDPOINT, body }
}

export async function executeTrackedQuery(input: OpenAITrackedQueryInput): Promise<OpenAIRawResult> {
  const model = input.config.model ?? DEFAULT_MODEL
  const params = buildTrackedQueryRequest(input).body as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming
  const client = createClient(input.config)

  let response: OpenAI.Responses.Response
  try {
    response = await withRetry(() => client.responses.create(params))
  } catch (err: unknown) {
    const msg = describeError(err)
    throw new Error(`[provider-openai] ${msg}`)
  }
  return parseTrackedQueryResponse(response, model)
}

/**
 * The second half of `executeTrackedQuery`: read one Responses API response
 * (the SDK's object, or the same response as stored JSON) into a result.
 * `model` is the model the request asked for.
 */
export function parseTrackedQueryResponse(body: object, model: string): OpenAIRawResult {
  const rawResponse = responseToRecord(body)
  const parsed = reparseStoredResult(rawResponse)

  return {
    provider: 'openai',
    rawResponse,
    model,
    servedModel: extractServedModel(rawResponse),
    groundingSources: parsed.groundingSources,
    searchQueries: parsed.searchQueries,
    usage: extractUsageFromRaw(rawResponse),
    stopReason: extractStopReasonFromRaw(rawResponse),
  }
}

export function normalizeResult(raw: OpenAIRawResult): OpenAINormalizedResult {
  const parsed = reparseStoredResult(raw.rawResponse)
  const useParsed = hasParsedResponseContent(raw.rawResponse)
  const groundingSources = useParsed ? parsed.groundingSources : raw.groundingSources
  const searchQueries = useParsed ? parsed.searchQueries : raw.searchQueries
  const citedDomains = extractCitedDomainsFromSources(groundingSources)

  return {
    provider: 'openai',
    answerText: parsed.answerText,
    citedDomains,
    groundingSources,
    searchQueries,
  }
}

function hasParsedResponseContent(rawResponse: Record<string, unknown>): boolean {
  return Array.isArray(rawResponse.output) && rawResponse.output.length > 0
}

/**
 * Read the model OpenAI reported serving off a stored raw response. A response that
 * omits `model` yields undefined rather than the configured model.
 */
export function extractServedModel(rawResponse: Record<string, unknown>): string | undefined {
  return normalizeServedModel(rawResponse.model)
}

export function reparseStoredResult(rawResponse: Record<string, unknown>): OpenAINormalizedResult {
  const groundingSources = extractGroundingSourcesFromRaw(rawResponse)
  const searchQueries = extractSearchQueriesFromRaw(rawResponse)

  return {
    provider: 'openai',
    answerText: extractAnswerTextFromRaw(rawResponse),
    citedDomains: extractCitedDomainsFromSources(groundingSources),
    groundingSources,
    searchQueries,
  }
}

// --- Internal helpers ---

export function buildPrompt(query: string): string {
  return query
}

function extractResponseText(response: OpenAI.Responses.Response): string {
  try {
    const parts: string[] = []
    for (const item of response.output) {
      if (item.type === 'message') {
        for (const content of item.content) {
          if (content.type === 'output_text') {
            parts.push(content.text)
          }
        }
      }
    }
    return parts.join('')
  } catch {
    return ''
  }
}

function extractGroundingSourcesFromRaw(rawResponse: Record<string, unknown>): GroundingSource[] {
  const sources: GroundingSource[] = []
  const seen = new Set<string>()
  try {
    // OpenAI's web-search guide returns citations in the final message, and the official
    // SDK types model those as `output_text.annotations` entries with `type: "url_citation"`.
    // Docs: https://developers.openai.com/api/docs/guides/tools-web-search
    // SDK: https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_text.py
    const output = rawResponse.output as Array<{
      type?: string
      content?: Array<{
        type?: string
        annotations?: Array<{
          type?: string
          url?: string
          title?: string | null
        }>
      }>
    }> | undefined
    if (!output) return []

    for (const item of output) {
      if (item.type === 'message') {
        for (const content of item.content ?? []) {
          if (content.type === 'output_text' && content.annotations) {
            for (const annotation of content.annotations) {
              if (annotation.type === 'url_citation' && typeof annotation.url === 'string' && !seen.has(annotation.url)) {
                seen.add(annotation.url)
                sources.push({
                  uri: annotation.url,
                  title: annotation.title ?? '',
                })
              }
            }
          }
        }
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return sources
}

function extractSearchQueriesFromRaw(rawResponse: Record<string, unknown>): string[] {
  const queries = new Set<string>()
  try {
    // The official Responses SDK types put search telemetry on `web_search_call.action`
    // rather than on the top-level item. `query` is deprecated in favor of `queries`, so
    // we accept both when reparsing stored payloads.
    // Docs: https://developers.openai.com/api/docs/guides/tools-web-search
    // SDK: https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_function_web_search.py
    const output = rawResponse.output as Array<{
      type?: string
      action?: {
        type?: string
        query?: unknown
        queries?: unknown
      }
    }> | undefined
    if (!output) return []

    for (const item of output) {
      if (item.type !== 'web_search_call' || !item.action) continue
      const action = item.action
      if (typeof action.query === 'string' && action.query.length > 0) {
        queries.add(action.query)
      }
      if (Array.isArray(action.queries)) {
        for (const query of action.queries) {
          if (typeof query === 'string' && query.length > 0) {
            queries.add(query)
          }
        }
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return [...queries]
}

function extractAnswerTextFromRaw(rawResponse: Record<string, unknown>): string {
  try {
    const output = rawResponse.output as Array<{
      type: string
      content?: Array<{ type: string; text?: string }>
    }> | undefined

    if (!output) return ''

    const parts: string[] = []
    for (const item of output) {
      if (item.type === 'message' && item.content) {
        for (const content of item.content) {
          if (content.type === 'output_text' && content.text) {
            parts.push(content.text)
          }
        }
      }
    }
    return parts.join('')
  } catch {
    return ''
  }
}

/**
 * Billable usage off a Responses API response. `input_tokens` includes the
 * cached tokens it itself breaks out, so they are subtracted to leave the
 * uncached remainder; `output_tokens` already includes reasoning. Searches are
 * counted as the response's `web_search_call` output items.
 * A response with no usage object yields undefined, never a zero-cost answer.
 * Docs: https://platform.openai.com/docs/api-reference/responses/object
 */
function extractUsageFromRaw(rawResponse: Record<string, unknown>): ProviderUsage | undefined {
  const usage = rawResponse.usage as {
    input_tokens?: unknown
    input_tokens_details?: { cached_tokens?: unknown } | null
    output_tokens?: unknown
  } | null | undefined
  if (usage === null || typeof usage !== 'object') return undefined

  const inputTokens = usageCount(usage.input_tokens)
  const cachedInputTokens = usageCount(usage.input_tokens_details?.cached_tokens)
  const output = Array.isArray(rawResponse.output) ? rawResponse.output as Array<{ type?: unknown }> : []
  return {
    inputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    cacheWriteTokens: 0,
    outputTokens: usageCount(usage.output_tokens),
    searchCount: output.filter((item) => item?.type === 'web_search_call').length,
  }
}

/** Why the response stopped: `incomplete_details.reason` when it has one, else `status`. */
function extractStopReasonFromRaw(rawResponse: Record<string, unknown>): string | undefined {
  const incomplete = rawResponse.incomplete_details as { reason?: unknown } | null | undefined
  const reason = incomplete !== null && typeof incomplete === 'object' ? incomplete.reason : undefined
  if (typeof reason === 'string' && reason.length > 0) return reason
  const status = rawResponse.status
  return typeof status === 'string' && status.length > 0 ? status : undefined
}

function extractCitedDomainsFromSources(groundingSources: GroundingSource[]): string[] {
  const domains = new Set<string>()

  for (const source of groundingSources) {
    const domain = extractDomainFromUri(source.uri)
    if (domain) domains.add(domain)
  }

  return [...domains]
}

function extractDomainFromUri(uri: string): string | null {
  const hostname = hostOf(uri)
  if (
    !hostname
    || !registrableDomain(hostname)
    || hostMatchesAnyDomain(hostname, AI_ENGINE_SELF_DOMAINS.chatgpt)
  ) return null
  return hostname
}

export async function generateText(prompt: string, config: OpenAIConfig): Promise<string> {
  const model = config.model ?? DEFAULT_MODEL
  const client = createClient(config)
  const response = await withRetry(() =>
    client.responses.create({
      model,
      input: prompt,
    }),
  )
  return extractResponseText(response)
}

/** Detach a response into plain JSON, the shape stored as `apiResponse`. */
function responseToRecord(response: object): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(response)) as Record<string, unknown>
  } catch {
    return { error: 'failed to serialize response' }
  }
}
