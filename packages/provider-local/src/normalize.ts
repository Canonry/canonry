import OpenAI from 'openai'
import type {
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
    const models = await client.models.list()
    const modelList = []
    for await (const m of models) {
      modelList.push(m.id)
      if (modelList.length >= 5) break
    }
    return {
      ok: true,
      provider: 'local',
      message: `connected, ${modelList.length} model(s) available`,
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

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant. Provide comprehensive, factual answers. When mentioning websites or services, include their domain names.',
      },
      {
        role: 'user',
        content: buildPrompt(input.keyword),
      },
    ],
  })

  return {
    provider: 'local',
    rawResponse: JSON.parse(JSON.stringify(response)) as Record<string, unknown>,
    model,
    groundingSources: [],
    searchQueries: [],
  }
}

export function normalizeResult(raw: LocalRawResult): LocalNormalizedResult {
  const answerText = extractAnswerText(raw.rawResponse)
  const citedDomains = extractDomainMentions(answerText)

  return {
    provider: 'local',
    answerText,
    citedDomains,
    groundingSources: raw.groundingSources,
    searchQueries: raw.searchQueries,
  }
}

// --- Internal helpers ---

function buildPrompt(keyword: string): string {
  return `Based on your training knowledge, what websites, services, or organizations are commonly associated with "${keyword}"? List the most relevant ones and include their domain names (e.g. example.com) where you know them.`
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
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
  })
  return response.choices[0]?.message?.content ?? ''
}

/**
 * Scan answer text for domain mentions — used as a citation heuristic
 * since local LLMs don't have structured grounding/search data.
 */
function extractDomainMentions(text: string): string[] {
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
