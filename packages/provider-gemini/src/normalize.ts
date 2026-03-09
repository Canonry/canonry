import { GoogleGenerativeAI, type EnhancedGenerateContentResponse, type GoogleSearchRetrievalTool } from '@google/generative-ai'
import type {
  GeminiConfig,
  GeminiHealthcheckResult,
  GeminiNormalizedResult,
  GeminiRawResult,
  GeminiTrackedQueryInput,
  GroundingSource,
} from './types.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'

export function validateConfig(config: GeminiConfig): GeminiHealthcheckResult {
  if (!config.apiKey || config.apiKey.length === 0) {
    return { ok: false, provider: 'gemini', message: 'missing api key' }
  }
  return {
    ok: true,
    provider: 'gemini',
    message: 'config valid',
    model: config.model ?? DEFAULT_MODEL,
  }
}

export async function healthcheck(config: GeminiConfig): Promise<GeminiHealthcheckResult> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation

  try {
    const genAI = new GoogleGenerativeAI(config.apiKey)
    const model = genAI.getGenerativeModel({ model: config.model ?? DEFAULT_MODEL })
    const result = await model.generateContent('Say "ok"')
    const text = result.response.text()
    return {
      ok: text.length > 0,
      provider: 'gemini',
      message: text.length > 0 ? 'gemini api key verified' : 'empty response from gemini',
      model: config.model ?? DEFAULT_MODEL,
    }
  } catch (err: unknown) {
    return {
      ok: false,
      provider: 'gemini',
      message: err instanceof Error ? err.message : String(err),
      model: config.model ?? DEFAULT_MODEL,
    }
  }
}

export async function executeTrackedQuery(input: GeminiTrackedQueryInput): Promise<GeminiRawResult> {
  const model = input.config.model ?? DEFAULT_MODEL
  const genAI = new GoogleGenerativeAI(input.config.apiKey)

  const searchTool: GoogleSearchRetrievalTool = { googleSearchRetrieval: {} }

  const generativeModel = genAI.getGenerativeModel({
    model,
    tools: [searchTool],
  })

  const prompt = buildPrompt(input.keyword)

  const result = await generativeModel.generateContent(prompt)
  const response = result.response

  // Extract grounding metadata from SDK response object
  const groundingMetadata = extractGroundingMetadata(response)
  const searchQueries = extractSearchQueries(response)

  return {
    provider: 'gemini',
    rawResponse: responseToRecord(response),
    model,
    groundingSources: groundingMetadata,
    searchQueries,
  }
}

export function normalizeResult(raw: GeminiRawResult): GeminiNormalizedResult {
  const answerText = extractAnswerText(raw.rawResponse)
  const citedDomains = extractCitedDomains(raw)

  return {
    provider: 'gemini',
    answerText,
    citedDomains,
    groundingSources: raw.groundingSources,
    searchQueries: raw.searchQueries,
  }
}

// --- Internal helpers ---

function buildPrompt(keyword: string): string {
  return keyword
}

function extractAnswerText(rawResponse: Record<string, unknown>): string {
  try {
    const candidates = rawResponse.candidates as Array<{
      content?: { parts?: Array<{ text?: string }> }
    }> | undefined

    if (!candidates || candidates.length === 0) return ''

    const parts = candidates[0]?.content?.parts
    if (!parts || parts.length === 0) return ''

    return parts.map(p => p.text ?? '').join('')
  } catch {
    return ''
  }
}

function extractGroundingMetadata(response: EnhancedGenerateContentResponse): GroundingSource[] {
  try {
    const candidate = response.candidates?.[0]
    if (!candidate) return []

    const metadata = candidate.groundingMetadata
    if (!metadata) return []

    const chunks = metadata.groundingChunks
    if (!chunks) return []

    return chunks
      .filter(chunk => chunk.web?.uri)
      .map(chunk => ({
        uri: chunk.web!.uri!,
        title: chunk.web?.title ?? '',
      }))
  } catch {
    return []
  }
}

function extractSearchQueries(response: EnhancedGenerateContentResponse): string[] {
  try {
    const candidate = response.candidates?.[0]
    return candidate?.groundingMetadata?.webSearchQueries ?? []
  } catch {
    return []
  }
}

function extractCitedDomains(raw: GeminiRawResult): string[] {
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
    return url.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function responseToRecord(response: EnhancedGenerateContentResponse): Record<string, unknown> {
  try {
    // Serialize the SDK response to a plain object for DB storage
    const candidates = response.candidates?.map(c => ({
      content: c.content,
      finishReason: c.finishReason,
      groundingMetadata: c.groundingMetadata ? {
        webSearchQueries: c.groundingMetadata.webSearchQueries,
        groundingChunks: c.groundingMetadata.groundingChunks,
      } : undefined,
    }))

    return {
      candidates: candidates ?? [],
      usageMetadata: response.usageMetadata ?? null,
    }
  } catch {
    return { error: 'failed to serialize response' }
  }
}
