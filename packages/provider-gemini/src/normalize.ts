import { GoogleGenAI, type GenerateContentResponse } from '@google/genai'
import type {
  GeminiConfig,
  GeminiHealthcheckResult,
  GeminiNormalizedResult,
  GeminiRawResult,
  GeminiTrackedQueryInput,
  GroundingSource,
} from './types.js'

const DEFAULT_MODEL = 'gemini-3-flash'
const VALIDATION_PATTERN = /^gemini-/

/**
 * Whether this config targets Vertex AI instead of AI Studio.
 */
function isVertexConfig(config: GeminiConfig): boolean {
  return !!config.vertexProject
}

/**
 * Resolve the effective model name, validating that it is a recognised Gemini
 * model identifier (must start with "gemini-").  If an invalid name is stored
 * the default is used and a warning is logged.
 */
function resolveModel(config: GeminiConfig): string {
  const m = config.model
  if (!m) return DEFAULT_MODEL
  if (VALIDATION_PATTERN.test(m)) return m
  const backend = isVertexConfig(config) ? 'Vertex AI' : 'AI Studio'
  console.warn(
    `[provider-gemini] Invalid model name "${m}" — this provider uses the Gemini ${backend} API ` +
    `which only accepts "gemini-*" model names. ` +
    `Falling back to ${DEFAULT_MODEL}.`,
  )
  return DEFAULT_MODEL
}

/**
 * Create a GoogleGenAI client — works for both AI Studio (apiKey) and
 * Vertex AI (project + location + optional service account credentials).
 */
function createClient(config: GeminiConfig): GoogleGenAI {
  if (isVertexConfig(config)) {
    return new GoogleGenAI({
      vertexai: true,
      project: config.vertexProject!,
      location: config.vertexRegion || 'us-central1',
      ...(config.vertexCredentials
        ? { googleAuthOptions: { keyFilename: config.vertexCredentials } }
        : {}),
    })
  }
  return new GoogleGenAI({ apiKey: config.apiKey })
}

export function validateConfig(config: GeminiConfig): GeminiHealthcheckResult {
  // Check for explicitly provided (but empty) Vertex project — user intended Vertex AI
  // but forgot to fill in the project ID. 'vertexProject' in config distinguishes
  // "key present but empty" from "key absent" (fallback to API key auth).
  if ('vertexProject' in config && config.vertexProject !== undefined && config.vertexProject.trim().length === 0) {
    return { ok: false, provider: 'gemini', message: 'missing Vertex AI project ID' }
  }

  if (isVertexConfig(config)) {
    const model = resolveModel(config)
    return {
      ok: true,
      provider: 'gemini',
      message: 'config valid (Vertex AI)',
      model,
    }
  }

  if (!config.apiKey || config.apiKey.length === 0) {
    return { ok: false, provider: 'gemini', message: 'missing api key' }
  }
  const model = resolveModel(config)
  const warning = config.model && !VALIDATION_PATTERN.test(config.model)
    ? ` (invalid model "${config.model}" replaced with default)`
    : ''
  return {
    ok: true,
    provider: 'gemini',
    message: `config valid${warning}`,
    model,
  }
}

export async function healthcheck(config: GeminiConfig): Promise<GeminiHealthcheckResult> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation

  try {
    const model = resolveModel(config)
    const client = createClient(config)
    const result = await client.models.generateContent({
      model,
      contents: 'Say "ok"',
    })
    const text = result.text ?? ''
    const backend = isVertexConfig(config) ? 'vertex ai' : 'api key'
    return {
      ok: text.length > 0,
      provider: 'gemini',
      message: text.length > 0 ? `gemini ${backend} verified` : `empty response from gemini ${backend}`,
      model,
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
  const model = resolveModel(input.config)
  const prompt = buildPrompt(input.keyword, input.location)
  const client = createClient(input.config)

  const result = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
    },
  })

  const groundingSources = extractGroundingMetadata(result)
  const searchQueries = extractSearchQueries(result)

  return {
    provider: 'gemini',
    rawResponse: responseToRecord(result),
    model,
    groundingSources,
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

function buildPrompt(keyword: string, location?: GeminiTrackedQueryInput['location']): string {
  if (location) {
    return `${keyword} (searching from ${location.city}, ${location.region}, ${location.country})`
  }
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

function extractGroundingMetadata(response: GenerateContentResponse): GroundingSource[] {
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

function extractSearchQueries(response: GenerateContentResponse): string[] {
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
    if (domain) {
      domains.add(domain)
      continue
    }
    // Gemini proxy URLs (vertexaisearch.cloud.google.com) use base64-encoded
    // redirect paths, so URI extraction fails. Fall back to the title field,
    // which reliably contains the domain name.
    if (source.title) {
      const titleDomain = extractDomainFromTitle(source.title)
      if (titleDomain) domains.add(titleDomain)
    }
  }

  return [...domains]
}

function extractDomainFromTitle(title: string): string | null {
  const trimmed = title.trim().toLowerCase()
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+$/.test(trimmed)) {
    return trimmed.replace(/^www\./, '')
  }
  return null
}

function extractDomainFromUri(uri: string): string | null {
  try {
    const url = new URL(uri)
    const hostname = url.hostname.replace(/^www\./, '')

    // Gemini returns grounding sources through a Google proxy:
    // vertexaisearch.cloud.google.com/grounding-api-redirect/...
    if (hostname === 'vertexaisearch.cloud.google.com') {
      const redirectPath = url.pathname.replace(/^\/grounding-api-redirect\//, '')
      if (redirectPath && redirectPath !== url.pathname) {
        try {
          const decoded = decodeURIComponent(redirectPath)
          if (decoded.startsWith('http')) {
            const realUrl = new URL(decoded)
            return realUrl.hostname.replace(/^www\./, '')
          }
        } catch {
          // Not a decodable URL
        }
      }
      return null
    }

    return hostname
  } catch {
    return null
  }
}

export async function generateText(prompt: string, config: GeminiConfig): Promise<string> {
  const model = resolveModel(config)
  const client = createClient(config)
  const result = await client.models.generateContent({
    model,
    contents: prompt,
  })
  return result.text ?? ''
}

function responseToRecord(response: GenerateContentResponse): Record<string, unknown> {
  try {
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
