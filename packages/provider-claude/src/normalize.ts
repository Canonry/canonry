import Anthropic from '@anthropic-ai/sdk'
import type { WebSearchTool20250305 } from '@anthropic-ai/sdk/resources/messages/messages.js'
import type {
  ClaudeConfig,
  ClaudeHealthcheckResult,
  ClaudeNormalizedResult,
  ClaudeRawResult,
  ClaudeTrackedQueryInput,
  GroundingSource,
} from './types.js'

const DEFAULT_MODEL = 'claude-sonnet-4-6'

export function validateConfig(config: ClaudeConfig): ClaudeHealthcheckResult {
  if (!config.apiKey || config.apiKey.length === 0) {
    return { ok: false, provider: 'claude', message: 'missing api key' }
  }
  return {
    ok: true,
    provider: 'claude',
    message: 'config valid',
    model: config.model ?? DEFAULT_MODEL,
  }
}

export async function healthcheck(config: ClaudeConfig): Promise<ClaudeHealthcheckResult> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation

  try {
    const client = new Anthropic({ apiKey: config.apiKey })
    const response = await client.messages.create({
      model: config.model ?? DEFAULT_MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Say "ok"' }],
    })
    const text = extractTextFromResponse(response)
    return {
      ok: text.length > 0,
      provider: 'claude',
      message: text.length > 0 ? 'claude api key verified' : 'empty response from claude',
      model: config.model ?? DEFAULT_MODEL,
    }
  } catch (err: unknown) {
    return {
      ok: false,
      provider: 'claude',
      message: err instanceof Error ? err.message : String(err),
      model: config.model ?? DEFAULT_MODEL,
    }
  }
}

export async function executeTrackedQuery(input: ClaudeTrackedQueryInput): Promise<ClaudeRawResult> {
  const model = input.config.model ?? DEFAULT_MODEL
  const client = new Anthropic({ apiKey: input.config.apiKey })

  const webSearchTool: Record<string, unknown> = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
  }
  if (input.location) {
    webSearchTool.user_location = {
      type: 'approximate',
      city: input.location.city,
      region: input.location.region,
      country: input.location.country,
      ...(input.location.timezone ? { timezone: input.location.timezone } : {}),
    }
  }

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [webSearchTool as unknown as WebSearchTool20250305],
    messages: [{ role: 'user', content: input.keyword }],
  })

  const groundingSources = extractGroundingSources(response)
  const searchQueries = extractSearchQueries(response)

  return {
    provider: 'claude',
    rawResponse: responseToRecord(response),
    model,
    groundingSources,
    searchQueries,
  }
}

export function normalizeResult(raw: ClaudeRawResult): ClaudeNormalizedResult {
  const answerText = extractAnswerTextFromRaw(raw.rawResponse)
  const citedDomains = extractCitedDomains(raw)

  return {
    provider: 'claude',
    answerText,
    citedDomains,
    groundingSources: raw.groundingSources,
    searchQueries: raw.searchQueries,
  }
}

// --- Internal helpers ---

function extractTextFromResponse(response: Anthropic.Message): string {
  try {
    const parts: string[] = []
    for (const block of response.content) {
      if (block.type === 'text') {
        parts.push(block.text)
      }
    }
    return parts.join('')
  } catch {
    return ''
  }
}

function extractGroundingSources(response: Anthropic.Message): GroundingSource[] {
  const sources: GroundingSource[] = []
  try {
    for (const block of response.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const result of block.content) {
          if (result.type === 'web_search_result') {
            sources.push({
              uri: result.url,
              title: result.title ?? '',
            })
          }
        }
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return sources
}

function extractSearchQueries(response: Anthropic.Message): string[] {
  // Extract search queries from server_tool_use blocks (web_search is a server tool)
  const queries: string[] = []
  try {
    for (const block of response.content) {
      if (block.type === 'server_tool_use' && block.name === 'web_search') {
        const input = block.input as { query?: string }
        if (input.query) {
          queries.push(input.query)
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
    const content = rawResponse.content as Array<{
      type: string
      text?: string
    }> | undefined

    if (!content) return ''

    const parts: string[] = []
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text)
      }
    }
    return parts.join('')
  } catch {
    return ''
  }
}

function extractCitedDomains(raw: ClaudeRawResult): string[] {
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

export async function generateText(prompt: string, config: ClaudeConfig): Promise<string> {
  const model = config.model ?? DEFAULT_MODEL
  const client = new Anthropic({ apiKey: config.apiKey })
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })
  return extractTextFromResponse(response)
}

function responseToRecord(response: Anthropic.Message): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(response)) as Record<string, unknown>
  } catch {
    return { error: 'failed to serialize response' }
  }
}
