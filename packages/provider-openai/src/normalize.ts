import OpenAI from 'openai'
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
    const client = new OpenAI({ apiKey: config.apiKey })
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
      message: err instanceof Error ? err.message : String(err),
      model: config.model ?? DEFAULT_MODEL,
    }
  }
}

export async function executeTrackedQuery(input: OpenAITrackedQueryInput): Promise<OpenAIRawResult> {
  const model = input.config.model ?? DEFAULT_MODEL
  const client = new OpenAI({ apiKey: input.config.apiKey })

  const webSearchTool: Record<string, unknown> = { type: 'web_search_preview' }
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
        tools: [webSearchTool as { type: 'web_search_preview' }],
        tool_choice: 'required' as never,
        input: buildPrompt(input.keyword),
      }),
    )

    const rawResponse = responseToRecord(response)
    const parsed = reparseStoredResult(rawResponse)

    return {
      provider: 'openai',
      rawResponse,
      model,
      groundingSources: parsed.groundingSources,
      searchQueries: parsed.searchQueries,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
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
  }
}

function hasParsedResponseContent(rawResponse: Record<string, unknown>): boolean {
  return Array.isArray(rawResponse.output) && rawResponse.output.length > 0
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

export function buildPrompt(keyword: string): string {
  return keyword
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
  try {
    const url = new URL(uri)
    return url.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

export async function generateText(prompt: string, config: OpenAIConfig): Promise<string> {
  const model = config.model ?? DEFAULT_MODEL
  const client = new OpenAI({ apiKey: config.apiKey })
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
