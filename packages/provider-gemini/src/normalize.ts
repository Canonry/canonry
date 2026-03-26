import { GoogleGenerativeAI, type EnhancedGenerateContentResponse } from '@google/generative-ai'
import { VertexAI, type GenerateContentResponse as VertexGenerateContentResponse } from '@google-cloud/vertexai'
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
 * (e.g. "vertex", which refers to a different product) the default is used and
 * a warning is logged so the misconfiguration is visible in server logs.
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
 * Unified response shape for both AI Studio and Vertex AI SDK responses.
 * We extract just what we need so the rest of the code is backend-agnostic.
 */
interface UnifiedResponse {
  text: () => string
  candidates: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
    groundingMetadata?: {
      webSearchQueries?: string[]
      groundingChunks?: Array<{
        web?: { uri?: string; title?: string }
      }>
    }
  }> | undefined
  usageMetadata?: unknown
}

function wrapVertexResponse(response: VertexGenerateContentResponse): UnifiedResponse {
  return {
    text: () => {
      const parts = response.candidates?.[0]?.content?.parts
      return parts?.map(p => p.text ?? '').join('') ?? ''
    },
    candidates: response.candidates?.map(c => ({
      content: c.content,
      finishReason: c.finishReason as string | undefined,
      groundingMetadata: c.groundingMetadata as UnifiedResponse['candidates'] extends Array<infer T> ? T extends { groundingMetadata?: infer M } ? M : undefined : undefined,
    })),
    usageMetadata: response.usageMetadata,
  }
}

/**
 * Create a generative model using Vertex AI (ADC / service account auth).
 */
function createVertexModel(config: GeminiConfig, model: string, tools?: unknown[]) {
  const vertexOpts: ConstructorParameters<typeof VertexAI>[0] = {
    project: config.vertexProject!,
    location: config.vertexRegion || 'us-central1',
    googleAuthOptions: config.vertexCredentials
      ? { keyFilename: config.vertexCredentials }
      : undefined,
  }
  const vertexAI = new VertexAI(vertexOpts)
  return vertexAI.getGenerativeModel({
    model,
    ...(tools ? { tools: tools as never[] } : {}),
  })
}

export function validateConfig(config: GeminiConfig): GeminiHealthcheckResult {
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
    if (isVertexConfig(config)) {
      const generativeModel = createVertexModel(config, model)
      const result = await generativeModel.generateContent('Say "ok"')
      const text = result.response.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
      return {
        ok: text.length > 0,
        provider: 'gemini',
        message: text.length > 0 ? 'gemini vertex ai verified' : 'empty response from gemini vertex ai',
        model,
      }
    } else {
      const genAI = new GoogleGenerativeAI(config.apiKey)
      const generativeModel = genAI.getGenerativeModel({ model })
      const result = await generativeModel.generateContent('Say "ok"')
      const text = result.response.text()
      return {
        ok: text.length > 0,
        provider: 'gemini',
        message: text.length > 0 ? 'gemini api key verified' : 'empty response from gemini',
        model,
      }
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

  if (isVertexConfig(input.config)) {
    // Vertex AI SDK: newer models (gemini-2.5+) require googleSearch; older models used googleSearchRetrieval.
    // Use googleSearch which works across all current stable Vertex models.
    const vertexSearchTool = { googleSearch: {} }
    const generativeModel = createVertexModel(input.config, model, [vertexSearchTool] as unknown[])
    const result = await generativeModel.generateContent(prompt)
    const response = result.response
    const unified = wrapVertexResponse(response)
    const groundingMetadata = extractGroundingMetadataFromUnified(unified)
    const searchQueries = extractSearchQueriesFromUnified(unified)

    return {
      provider: 'gemini',
      rawResponse: unifiedToRecord(unified),
      model,
      groundingSources: groundingMetadata,
      searchQueries,
    }
  } else {
    // AI Studio SDK uses googleSearch (replaces deprecated googleSearchRetrieval).
    // SDK types don't include this yet, so we cast through unknown.
    const searchTool = { googleSearch: {} }
    const genAI = new GoogleGenerativeAI(input.config.apiKey)
    const generativeModel = genAI.getGenerativeModel({
      model,
      tools: [searchTool as unknown as Record<string, unknown>],
    })

    const result = await generativeModel.generateContent(prompt)
    const response = result.response
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

function buildPrompt(keyword: string, location?: import('./types.js').GeminiTrackedQueryInput['location']): string {
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

function extractGroundingMetadataFromUnified(response: UnifiedResponse): GroundingSource[] {
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

function extractSearchQueriesFromUnified(response: UnifiedResponse): string[] {
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
    // Try extracting from URI first
    const domain = extractDomainFromUri(source.uri)
    if (domain) {
      domains.add(domain)
      continue
    }
    // Gemini proxy URLs (vertexaisearch.cloud.google.com) use base64-encoded
    // redirect paths, so URI extraction fails. Fall back to the title field,
    // which reliably contains the domain name (e.g. "pbjmarketing.com").
    if (source.title) {
      const titleDomain = extractDomainFromTitle(source.title)
      if (titleDomain) domains.add(titleDomain)
    }
  }

  return [...domains]
}

function extractDomainFromTitle(title: string): string | null {
  // The title is often just a bare domain like "pbjmarketing.com"
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
    // The real target URL is encoded in the path after the redirect prefix.
    if (hostname === 'vertexaisearch.cloud.google.com') {
      // Try to extract real URL from the redirect path
      // Format: /grounding-api-redirect/<encoded-url-or-path>
      const redirectPath = url.pathname.replace(/^\/grounding-api-redirect\//, '')
      if (redirectPath && redirectPath !== url.pathname) {
        // The path may contain a URL-like string (e.g., "aHR0cHM6..." base64, or direct URL segments)
        // Try decoding as a URL first
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
      // If we can't extract from redirect, skip this proxy domain
      return null
    }

    return hostname
  } catch {
    return null
  }
}

export async function generateText(prompt: string, config: GeminiConfig): Promise<string> {
  const model = resolveModel(config)
  if (isVertexConfig(config)) {
    const generativeModel = createVertexModel(config, model)
    const result = await generativeModel.generateContent(prompt)
    return result.response.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
  } else {
    const genAI = new GoogleGenerativeAI(config.apiKey)
    const generativeModel = genAI.getGenerativeModel({ model })
    const result = await generativeModel.generateContent(prompt)
    return result.response.text()
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

function unifiedToRecord(response: UnifiedResponse): Record<string, unknown> {
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
