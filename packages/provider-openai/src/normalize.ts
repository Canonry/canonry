import OpenAI from 'openai'
import {
  AI_ENGINE_SELF_DOMAINS,
  hostMatchesAnyDomain,
  hostOf,
  normalizeServedModel,
  registrableDomain,
  describeError,
  RetrievalContracts,
  RetrievalStatuses,
} from '@ainyc/canonry-contracts'
import { withRetry } from './utils.js'
import type {
  OpenAIConfig,
  OpenAIHealthcheckResult,
  OpenAINormalizedResult,
  OpenAIRawResult,
  OpenAITrackedQueryInput,
  GroundingSource,
  RetrievalContract,
  RetrievalStatus,
} from './types.js'

const DEFAULT_MODEL = 'gpt-5.4'

/**
 * The measurement contract this provider executes, recorded on every snapshot
 * so trends cannot silently mix methods.
 *
 * `search-required-v1`: the unmodified user query as `input`, no
 * `instructions` (system prompt), and `tool_choice: "required"` with
 * `web_search` as the only tool, so the model must search before it answers.
 * `required` forces a call to some tool; it forces a search only because no
 * other tool is offered. It measures a search-grounded answer, NOT a
 * reproduction of ChatGPT, whose system instructions, routing, and search
 * policy are not public.
 *
 * Every published release (1.0.0 onward) has sent `tool_choice: "required"`,
 * and every release that recorded a contract (4.139.0 onward) built this exact
 * request while labelling it `native-auto-v1`. That label was wrong: the model
 * was never left to decide. `canonry backfill answer-visibility` corrects those
 * rows; see `correctStoredOpenAIRetrieval` in packages/canonry.
 *
 * https://platform.openai.com/docs/api-reference/responses/create (`tool_choice`)
 * https://developers.openai.com/api/docs/guides/tools-web-search
 */
export const OPENAI_RETRIEVAL_CONTRACT: RetrievalContract = RetrievalContracts['search-required-v1']

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

export async function executeTrackedQuery(input: OpenAITrackedQueryInput): Promise<OpenAIRawResult> {
  const model = input.config.model ?? DEFAULT_MODEL
  const client = createClient(input.config)

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

  try {
    const response = await withRetry(() =>
      client.responses.create({
        model,
        tools: [webSearchTool as { type: 'web_search' }],
        // search-required-v1: web_search is the only tool, so requiring a tool
        // call requires a search. See OPENAI_RETRIEVAL_CONTRACT.
        tool_choice: 'required' as never,
        input: buildPrompt(input.query),
      }),
    )

    const rawResponse = responseToRecord(response)
    const parsed = reparseStoredResult(rawResponse)

    return {
      provider: 'openai',
      rawResponse,
      model,
      servedModel: extractServedModel(rawResponse),
      groundingSources: parsed.groundingSources,
      searchQueries: parsed.searchQueries,
      retrievalStatus: parsed.retrievalStatus,
      retrievalContract: OPENAI_RETRIEVAL_CONTRACT,
    }
  } catch (err: unknown) {
    const msg = describeError(err)
    throw new Error(`[provider-openai] ${msg}`)
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
    retrievalStatus: useParsed ? parsed.retrievalStatus : raw.retrievalStatus,
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
    retrievalStatus: extractRetrievalStatusFromRaw(rawResponse),
  }
}

// --- Internal helpers ---

/**
 * Read retrieval from the presence of a `web_search_call` output item rather
 * than from `searchQueries`. A call whose action carries no query (or opened a
 * page instead of searching) still counts: retrieval is the denominator
 * question, the query text is only telemetry.
 *
 * `unknown`, never `not-used`, when the output array is missing, unusable, or
 * empty, or when the response says it did not finish (`incomplete`, `failed`,
 * ...) and shows no search call: neither is an intact response, so neither can
 * prove that no search happened. A search call is proof on its own, whatever
 * the response status.
 */
function extractRetrievalStatusFromRaw(rawResponse: Record<string, unknown>): RetrievalStatus {
  const output = rawResponse.output
  if (!Array.isArray(output) || output.length === 0) return RetrievalStatuses.unknown
  const searched = output.some(item =>
    item !== null && typeof item === 'object' && (item as { type?: unknown }).type === 'web_search_call',
  )
  if (searched) return RetrievalStatuses.used
  if (typeof rawResponse.status === 'string' && rawResponse.status !== 'completed') {
    return RetrievalStatuses.unknown
  }
  return RetrievalStatuses['not-used']
}

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

function responseToRecord(response: OpenAI.Responses.Response): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(response)) as Record<string, unknown>
  } catch {
    return { error: 'failed to serialize response' }
  }
}
