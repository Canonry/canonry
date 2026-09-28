import OpenAI from 'openai'
import {
  AI_ENGINE_SELF_DOMAINS,
  hostMatchesAnyDomain,
  hostOf,
  normalizeServedModel,
  registrableDomain,
  resolveProviderModel,
  describeError,
  usageCount,
} from '@ainyc/canonry-contracts'
import type { ProviderUsage, TrackedQueryRequest } from '@ainyc/canonry-contracts'
import { withRetry } from './utils.js'
import type {
  PerplexityAgentRequest,
  PerplexityAgentSelection,
  PerplexityConfig,
  PerplexityHealthcheckResult,
  PerplexityNormalizedResult,
  PerplexityRawResult,
  PerplexityTrackedQueryInput,
  PerplexityWebSearchTool,
  GroundingSource,
  RetrievalContract,
  RetrievalStatus,
} from './types.js'

/**
 * Perplexity's suggested replacement for `sonar`, and the default engine.
 * Docs: https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar
 */
export const DEFAULT_MODEL = 'fast'

// The OpenAI SDK is used as a plain HTTP client: `post('/agent')` below hits the
// canonical Agent API endpoint (`/v1/responses` is only an alias), keeps the
// SDK's typed `APIError` with `.status` that `isRetryableHttpError` keys on,
// and keeps the Bearer auth this provider has always used.
const BASE_URL = 'https://api.perplexity.ai/v1'
const AGENT_PATH = '/agent'

/** The path a tracked query is posted to, relative to the API host (`BASE_URL` + `AGENT_PATH`). */
export const PERPLEXITY_AGENT_ENDPOINT = '/v1/agent'

/**
 * The measurement contract this provider executes. `search-required-v1`: the
 * unmodified query, no `instructions` from Canonry, and `tool_choice` pinned to
 * `web_search`, so retrieval is guaranteed by the API control rather than left
 * to the preset. A preset still applies its own built-in prompt and model; that
 * is part of the engine being measured, like any consumer surface's hidden
 * prompt, and it is recorded through `model` (the preset) and `servedModel`.
 *
 * Sonar searched on every request, so its rows carry no contract that could be
 * mistaken for this one: they predate the field or say `native-auto-v1`.
 */
export const PERPLEXITY_RETRIEVAL_CONTRACT: RetrievalContract = 'search-required-v1'

/**
 * Output item types that are a retrieval call. `search_results` is the
 * `web_search` tool's output; `fetch_url_results` is a page the agent read.
 */
const RETRIEVAL_OUTPUT_TYPES: ReadonlySet<string> = new Set(['search_results', 'fetch_url_results'])

/**
 * The preset or model slug a configured id runs as. A retired Sonar name
 * resolves through the shared alias table (`sonar` → `fast`, …), so this is
 * also the value recorded as the requested model.
 */
export function resolveModel(model: string | undefined): string {
  const trimmed = model?.trim()
  return resolveProviderModel('perplexity', trimmed ? trimmed : DEFAULT_MODEL)
}

/**
 * The Agent API requires `max_output_tokens` for `anthropic/*` models and
 * answers 400 without it. 4096 is the Claude provider's answer budget. Other
 * slugs and presets stay uncapped: on presets a tight cap can be spent on
 * reasoning before any answer appears.
 * Docs: https://docs.perplexity.ai/api-reference/agent-post
 */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 4096

/**
 * A `vendor/model` slug names one model; anything else is a preset. Every
 * request path (sweep, key check, text generation) builds on this, so a
 * model's required fields travel with it.
 */
export function agentSelection(model: string): PerplexityAgentSelection {
  if (!model.includes('/')) return { preset: model }
  return model.startsWith('anthropic/') ? { model, max_output_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS } : { model }
}

/**
 * The request a tracked query sends. The query goes in unmodified; the
 * location rides on the search tool as `user_location`, never in the text.
 * Listing `web_search` explicitly (rather than relying on a preset's bundled
 * one) keeps the request shape identical with and without a location, and it
 * is required for `tool_choice` on a model slug.
 */
export function buildAgentRequest(
  query: string,
  model: string,
  location?: PerplexityTrackedQueryInput['location'],
): PerplexityAgentRequest {
  const webSearch: PerplexityWebSearchTool = { type: 'web_search' }
  if (location) {
    webSearch.user_location = {
      city: location.city,
      region: location.region,
      country: location.country,
    }
  }
  return {
    ...agentSelection(model),
    input: query,
    tools: [webSearch],
    tool_choice: { type: 'web_search' },
  }
}

export function validateConfig(config: PerplexityConfig): PerplexityHealthcheckResult {
  if (!config.apiKey || config.apiKey.length === 0) {
    return { ok: false, provider: 'perplexity', message: 'missing api key' }
  }
  return {
    ok: true,
    provider: 'perplexity',
    message: 'config valid',
    model: resolveModel(config.model),
  }
}

export async function healthcheck(config: PerplexityConfig): Promise<PerplexityHealthcheckResult> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation

  const model = resolveModel(config.model)
  try {
    const client = createClient(config.apiKey)
    // Same engine as a sweep, so a mistyped preset fails here; no forced search.
    const response = await withRetry(() =>
      postAgent(client, { ...agentSelection(model), input: 'Say "ok"' }),
    )
    assertUsableResponse(response)
    const text = extractAgentAnswerText(response)
    return {
      ok: text.length > 0,
      provider: 'perplexity',
      message: text.length > 0 ? 'perplexity api key verified' : 'empty response from perplexity',
      model,
    }
  } catch (err: unknown) {
    return {
      ok: false,
      provider: 'perplexity',
      message: describeError(err),
      model,
    }
  }
}

/** A tracked query's request, with the Agent API body type the sync path posts. */
type PerplexityTrackedQueryRequest = TrackedQueryRequest & { body: PerplexityAgentRequest }

/** The first half of `executeTrackedQuery`: the exact Agent API request it posts. */
export function buildTrackedQueryRequest(input: PerplexityTrackedQueryInput): PerplexityTrackedQueryRequest {
  return {
    endpoint: PERPLEXITY_AGENT_ENDPOINT,
    body: buildAgentRequest(input.query, resolveModel(input.config.model), input.location),
  }
}

export async function executeTrackedQuery(input: PerplexityTrackedQueryInput): Promise<PerplexityRawResult> {
  const model = resolveModel(input.config.model)
  const client = createClient(input.config.apiKey)
  const { body } = buildTrackedQueryRequest(input)

  try {
    const rawResponse = await withRetry(() => postAgent(client, body))
    // Inside the try: a failed run arrives as HTTP 200 and is reported like
    // any other provider error. It is never retried.
    return parseTrackedQueryResponse(rawResponse, model)
  } catch (err: unknown) {
    const msg = describeError(err)
    throw new Error(`[provider-perplexity] ${msg}`)
  }
}

/**
 * The second half of `executeTrackedQuery`: read one Agent API response into
 * a result, throwing on a failed, cancelled, or answerless run exactly as the
 * sync path does. `model` is the id the request asked for; a retired one is
 * recorded as the preset it resolves to, the same as the sync path records.
 */
export function parseTrackedQueryResponse(body: Record<string, unknown>, model: string): PerplexityRawResult {
  assertUsableResponse(body)
  const parsed = reparseStoredResult(body)

  return {
    provider: 'perplexity',
    rawResponse: body,
    model: resolveModel(model),
    servedModel: extractServedModel(body),
    groundingSources: parsed.groundingSources,
    searchQueries: parsed.searchQueries,
    retrievalStatus: parsed.retrievalStatus,
    usage: extractAgentUsage(body),
    stopReason: extractAgentStopReason(body),
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
    retrievalStatus: useParsed ? parsed.retrievalStatus : raw.retrievalStatus ?? 'unknown',
  }
}

function hasParsedResponseContent(rawResponse: Record<string, unknown>): boolean {
  const agent = agentResponseOf(rawResponse)
  if (agent) return agentOutput(agent).length > 0
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

/**
 * Read the model Perplexity reported serving off a stored raw response. Both
 * Sonar and Agent API responses carry it as top-level `model`; for a preset it
 * is the model the preset resolved to. A response that omits `model` yields
 * undefined rather than the configured preset.
 */
export function extractServedModel(rawResponse: Record<string, unknown>): string | undefined {
  return normalizeServedModel(rawResponse.model)
}

/**
 * Parse a raw response, either shape, direct or wrapped under `apiResponse` as
 * the job runner stores it. Agent API responses carry an `output` array; rows
 * written before the migration are Sonar Chat Completions and keep their own
 * parser, so reparse and backfill of old sweeps read them as before.
 */
export function reparseStoredResult(rawResponse: Record<string, unknown>): PerplexityNormalizedResult {
  const agent = agentResponseOf(rawResponse)
  if (agent) return parseAgentResponse(agent)
  return parseSonarResponse(rawResponse)
}

// --- Agent API (current) ---

function createClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: BASE_URL })
}

function postAgent(client: OpenAI, body: PerplexityAgentRequest): Promise<Record<string, unknown>> {
  return client.post<Record<string, unknown>>(AGENT_PATH, { body })
}

/**
 * The Agent API reports a failed or cancelled run as HTTP 200 with `status`
 * and `error` set, so the HTTP layer alone would store it as an empty answer.
 * `incomplete` (stopped before finishing, e.g. truncated) passes only when it
 * still carries answer text: one with none would otherwise be stored as a
 * measured non-mention and sit in every coverage denominator.
 */
function assertUsableResponse(response: Record<string, unknown>): void {
  const status = response.status
  if (status === undefined || status === 'completed') return
  if (status === 'incomplete') {
    if (extractAgentAnswerText(response).trim().length > 0) return
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : undefined
    const reason = typeof details?.reason === 'string' && details.reason.length > 0 ? details.reason : 'no reason given'
    throw new Error(`agent response incomplete with no answer: ${reason}`)
  }
  const error = isRecord(response.error) ? response.error : undefined
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : 'no error detail'
  const type = typeof error?.type === 'string' && error.type.length > 0 ? ` (${error.type})` : ''
  throw new Error(`agent response ${typeof status === 'string' ? status : describeError(status)}: ${message}${type}`)
}

function agentResponseOf(rawResponse: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(rawResponse.output)) return rawResponse
  const nested = extractNestedApiResponse(rawResponse)
  return nested && Array.isArray(nested.output) ? nested : null
}

function agentOutput(response: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(response.output) ? response.output.filter(isRecord) : []
}

function parseAgentResponse(response: Record<string, unknown>): PerplexityNormalizedResult {
  const groundingSources = extractAgentGroundingSources(response)
  return {
    provider: 'perplexity',
    answerText: extractAgentAnswerText(response),
    citedDomains: extractCitedDomains(groundingSources),
    groundingSources,
    searchQueries: extractAgentSearchQueries(response),
    retrievalStatus: extractAgentRetrievalStatus(response),
  }
}

/** Concatenated `output_text` of every `message` item — what `output_text` is in Perplexity's SDK. */
function extractAgentAnswerText(response: Record<string, unknown>): string {
  const parts: string[] = []
  for (const item of agentOutput(response)) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('')
}

/**
 * Sources, in output order, deduplicated by URL: the `search_results` item's
 * `results` (the documented home of citations — there is no top-level
 * `citations` any more), pages read through `fetch_url_results`, and any
 * `url_citation` annotations on the message, which are often empty.
 */
function extractAgentGroundingSources(response: Record<string, unknown>): GroundingSource[] {
  const sources: GroundingSource[] = []
  const seen = new Set<string>()
  const add = (entry: unknown) => {
    if (!isRecord(entry) || typeof entry.url !== 'string' || entry.url.length === 0) return
    if (seen.has(entry.url)) return
    seen.add(entry.url)
    sources.push({ uri: entry.url, title: typeof entry.title === 'string' ? entry.title : '' })
  }

  for (const item of agentOutput(response)) {
    if (item.type === 'search_results' && Array.isArray(item.results)) {
      item.results.forEach(add)
    } else if (item.type === 'fetch_url_results' && Array.isArray(item.contents)) {
      item.contents.forEach(add)
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isRecord(part) && Array.isArray(part.annotations)) part.annotations.forEach(add)
      }
    }
  }
  return sources
}

/** The queries the `web_search` tool ran, from each `search_results` item. */
function extractAgentSearchQueries(response: Record<string, unknown>): string[] {
  const queries = new Set<string>()
  for (const item of agentOutput(response)) {
    if (item.type !== 'search_results' || !Array.isArray(item.queries)) continue
    for (const query of item.queries) {
      if (typeof query === 'string' && query.trim().length > 0) queries.add(query)
    }
  }
  return [...queries]
}

/**
 * Billable usage off an Agent API response (`ResponsesUsage` in Perplexity's
 * SDK). `input_tokens_details` breaks cache reads and writes out of
 * `input_tokens`, as OpenAI's Responses usage does, so both are subtracted to
 * leave the uncached remainder. `searchCount` is the billed `web_search`
 * invocations from `tool_calls_details` when the response reports them, else
 * one per `search_results` output item (each is one executed search call).
 * A response with no usage object yields undefined, never a zero-cost answer.
 */
function extractAgentUsage(response: Record<string, unknown>): ProviderUsage | undefined {
  const usage = isRecord(response.usage) ? response.usage : undefined
  if (!usage) return undefined

  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  const cachedInputTokens = usageCount(details?.cache_read_input_tokens)
  const cacheWriteTokens = usageCount(details?.cache_creation_input_tokens)
  const toolCalls = isRecord(usage.tool_calls_details) ? usage.tool_calls_details : undefined
  const webSearch = isRecord(toolCalls?.web_search) ? toolCalls.web_search : undefined
  const searchCount = typeof webSearch?.invocation === 'number'
    ? usageCount(webSearch.invocation)
    : agentOutput(response).filter(item => item.type === 'search_results').length
  return {
    inputTokens: Math.max(0, usageCount(usage.input_tokens) - cachedInputTokens - cacheWriteTokens),
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: usageCount(usage.output_tokens),
    searchCount,
  }
}

/** Why the run stopped: `incomplete_details.reason` when it has one, else `status`. */
function extractAgentStopReason(response: Record<string, unknown>): string | undefined {
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : undefined
  if (typeof details?.reason === 'string' && details.reason.length > 0) return details.reason
  return typeof response.status === 'string' && response.status.length > 0 ? response.status : undefined
}

/**
 * `used` when the output carries a retrieval item, `not-used` when it carries
 * an answer and none, and `unknown` when there is no answer to judge by.
 */
function extractAgentRetrievalStatus(response: Record<string, unknown>): RetrievalStatus {
  const output = agentOutput(response)
  if (output.some(item => typeof item.type === 'string' && RETRIEVAL_OUTPUT_TYPES.has(item.type))) return 'used'
  if (output.some(item => item.type === 'message')) return 'not-used'
  return 'unknown'
}

// --- Sonar Chat Completions (stored history) ---

function parseSonarResponse(rawResponse: Record<string, unknown>): PerplexityNormalizedResult {
  const groundingSources = extractGroundingSources(rawResponse)

  return {
    provider: 'perplexity',
    answerText: extractAnswerText(rawResponse),
    citedDomains: extractCitedDomains(groundingSources),
    groundingSources,
    // Sonar documented `search_results` and `citations` on the response but no
    // returned search-query telemetry, so Canonry does not synthesize it.
    // Docs: https://docs.perplexity.ai/docs/sonar/openai-compatibility
    searchQueries: [],
    // Sonar's only retrieval marker was present on every stored row, so it
    // never discriminated a non-retrieving answer. `unknown` is what we know.
    retrievalStatus: 'unknown',
  }
}

/**
 * Extract the citations array from a Sonar response.
 *
 * Handles two shapes:
 * 1. Direct API response — `rawResponse.citations` (array of URL strings at top level)
 * 2. Stored DB format — `rawResponse.apiResponse.citations` (job-runner wraps the raw API
 *    response under an `apiResponse` key before persisting to query_snapshots.raw_response)
 *
 * Agent API responses have no top-level `citations`; their sources are read from
 * the `search_results` output item instead.
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
  // Sonar's documented response structure exposes `search_results` as the richer source
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
    if (!isRecord(result)) return []
    const url = result.url
    if (typeof url !== 'string' || url.length === 0) {
      return []
    }
    const title = result.title
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

// --- Shared ---

function extractNestedApiResponse(rawResponse: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(rawResponse.apiResponse) ? rawResponse.apiResponse : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  const hostname = hostOf(uri)
  if (
    !hostname
    || !registrableDomain(hostname)
    || hostMatchesAnyDomain(hostname, AI_ENGINE_SELF_DOMAINS.chatgpt)
  ) return null
  return hostname
}

export async function generateText(prompt: string, config: PerplexityConfig): Promise<string> {
  const model = resolveModel(config.model)
  const client = createClient(config.apiKey)
  const response = await withRetry(() => postAgent(client, { ...agentSelection(model), input: prompt }))
  assertUsableResponse(response)
  return extractAgentAnswerText(response)
}
