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

    const groundingSources = extractGroundingSources(response)
    const searchQueries = extractSearchQueries(response)

    return {
      provider: 'openai',
      rawResponse: responseToRecord(response),
      model,
      groundingSources,
      searchQueries,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[provider-openai] ${msg}`)
  }
}

export function normalizeResult(raw: OpenAIRawResult): OpenAINormalizedResult {
  const answerText = extractAnswerTextFromRaw(raw.rawResponse)
  const citedDomains = extractCitedDomains(raw)

  return {
    provider: 'openai',
    answerText,
    citedDomains,
    groundingSources: raw.groundingSources,
    searchQueries: raw.searchQueries,
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

function extractGroundingSources(response: OpenAI.Responses.Response): GroundingSource[] {
  const sources: GroundingSource[] = []
  const seen = new Set<string>()
  try {
    for (const item of response.output) {
      if (item.type === 'message') {
        for (const content of item.content) {
          if (content.type === 'output_text' && content.annotations) {
            for (const annotation of content.annotations) {
              if (annotation.type === 'url_citation' && !seen.has(annotation.url)) {
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

function extractSearchQueries(response: OpenAI.Responses.Response): string[] {
  // OpenAI doesn't expose search queries directly in the response
  // but we can extract from web_search_call output items if available
  const queries: string[] = []
  try {
    for (const item of response.output) {
      if (item.type === 'web_search_call' && 'query' in item) {
        const query = (item as unknown as { query?: unknown }).query
        if (typeof query === 'string' && query.length > 0) {
          queries.push(query)
        }
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return queries
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

function extractCitedDomains(raw: OpenAIRawResult): string[] {
  const domains = new Set<string>()

  for (const source of raw.groundingSources) {
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
