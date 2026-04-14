import OpenAI from 'openai'
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
      message: err instanceof Error ? err.message : String(err),
      model: config.model ?? DEFAULT_MODEL,
    }
  }
}

export async function executeTrackedQuery(input: LocalTrackedQueryInput): Promise<LocalRawResult> {
  const model = input.config.model ?? DEFAULT_MODEL
  const client = new OpenAI({
    baseURL: input.config.baseUrl,
    apiKey: input.config.apiKey || 'not-needed',
  })

  try {
    const response = await withRetry(() =>
      client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. Provide comprehensive, factual answers. When mentioning websites or services, include their domain names.',
          },
          {
            role: 'user',
            content: buildPrompt(input.keyword, input.location),
          },
        ],
      }),
    )

    return {
      provider: 'local',
      rawResponse: responseToRecord(response),
      model,
      groundingSources: [],
      searchQueries: [],
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[provider-local] ${msg}`)
  }
}

export function normalizeResult(raw: LocalRawResult): LocalNormalizedResult {
  const answerText = extractAnswerText(raw.rawResponse)
  const citedDomains = extractDomainMentions(answerText)
  const groundingSources: GroundingSource[] = citedDomains.map(domain => ({
    uri: `http://${domain}`,
    title: domain
  }))

  return {
    provider: 'local',
    answerText,
    citedDomains,
    groundingSources,
    searchQueries: raw.searchQueries,
  }
}

// --- Internal helpers ---

function buildPrompt(keyword: string, location?: import('./types.js').LocalTrackedQueryInput['location']): string {
  const locationContext = location ? ` The user is searching from ${location.city}, ${location.region}, ${location.country}.` : ''
  return `Based on your training knowledge, what websites, services, or organizations are commonly associated with "${keyword}"?${locationContext} List the most relevant ones and include their domain names (e.g. example.com) where you know them.`
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
 * Scan answer text for domain mentions — used as a citation heuristic
 * since local LLMs don't have structured grounding/search data.
 */
export function extractDomainMentions(text: string): string[] {
  const domains = new Set<string>()

  // Match URLs like https://example.com/path or http://example.com
  const urlPattern = /https?:\/\/([a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+)/g
  let match
  while ((match = urlPattern.exec(text)) !== null) {
    domains.add(match[1].replace(/^www\./, '').toLowerCase())
  }

  // Match bare domain mentions including subdomains (e.g. docs.example.com, foo.example.co.uk)
  const domainPattern = /(?:^|[\s(["'])((?:[a-zA-Z0-9][-a-zA-Z0-9]*\.)+(?:com|org|net|io|co|dev|ai|app|edu|gov|biz|info|tech|health|dental|legal|law|med|uk|us|ca|au|de|fr|es|it|nl|se|no|dk|fi|jp|cn|kr|br|mx|ru|in|sg|nz|za)(?:\.[a-zA-Z]{2})?)(?:[\s).,;/"']|$)/g
  while ((match = domainPattern.exec(text)) !== null) {
    domains.add(match[1].replace(/^www\./, '').toLowerCase())
  }

  return [...domains]
}

function responseToRecord(response: OpenAI.Chat.Completions.ChatCompletion): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(response)) as Record<string, unknown>
  } catch {
    return { error: 'failed to serialize response' }
  }
}
