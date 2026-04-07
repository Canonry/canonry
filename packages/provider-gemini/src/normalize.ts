import { GoogleGenAI, type GenerateContentResponse } from '@google/genai'
import { withRetry } from './utils.js'
import type {
  GeminiConfig,
  GeminiHealthcheckResult,
  GeminiNormalizedResult,
  GeminiRawResult,
  GeminiTrackedQueryInput,
  GroundingSource,
} from './types.js'

const DEFAULT_MODEL = 'gemini-3-flash'

/**
 * Whether this config targets Vertex AI instead of AI Studio.
 */
function isVertexConfig(config: GeminiConfig): boolean {
  return !!config.vertexProject
}

/**
 * Resolve the effective model name.  Google model naming is not standardised
 * to a single prefix (e.g. `learnlm-*`, `gemma-*` are valid Gemini API models),
 * so we accept any non-empty string and let the API reject truly invalid names
 * with a descriptive error.
 */
function resolveModel(config: GeminiConfig): string {
  return config.model || DEFAULT_MODEL
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
  return {
    ok: true,
    provider: 'gemini',
    message: 'config valid',
    model,
  }
}

export async function healthcheck(config: GeminiConfig): Promise<GeminiHealthcheckResult> {
  const validation = validateConfig(config)
  if (!validation.ok) return validation

  try {
    const model = resolveModel(config)
    const client = createClient(config)
    const result = await withRetry(() =>
      client.models.generateContent({
        model,
        contents: 'Say "ok"',
      }),
    )
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

  try {
    const result = await withRetry(() =>
      client.models.generateContent({
        model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      }),
    )

    const rawResponse = responseToRecord(result)
    const parsed = reparseStoredResult(rawResponse)

    return {
      provider: 'gemini',
      rawResponse,
      model,
      groundingSources: parsed.groundingSources,
      searchQueries: parsed.searchQueries,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[provider-gemini] ${msg}`)
  }
}

export function normalizeResult(raw: GeminiRawResult): GeminiNormalizedResult {
  const parsed = reparseStoredResult(raw.rawResponse)
  const useParsed = hasParsedResponseContent(raw.rawResponse)
  const groundingSources = useParsed ? parsed.groundingSources : raw.groundingSources
  const searchQueries = useParsed ? parsed.searchQueries : raw.searchQueries
  const citedDomains = extractCitedDomainsFromSources(groundingSources)

  return {
    provider: 'gemini',
    answerText: parsed.answerText,
    citedDomains,
    groundingSources,
    searchQueries,
  }
}

function hasParsedResponseContent(rawResponse: Record<string, unknown>): boolean {
  return Array.isArray(rawResponse.candidates) && rawResponse.candidates.length > 0
}

export function reparseStoredResult(rawResponse: Record<string, unknown>): GeminiNormalizedResult {
  const groundingSources = extractGroundingMetadataFromRaw(rawResponse)
  const searchQueries = extractSearchQueriesFromRaw(rawResponse)

  return {
    provider: 'gemini',
    answerText: extractAnswerText(rawResponse),
    citedDomains: extractCitedDomainsFromSources(groundingSources),
    groundingSources,
    searchQueries,
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

function extractGroundingMetadataFromRaw(rawResponse: Record<string, unknown>): GroundingSource[] {
  try {
    // Google documents `groundingChunks` as the pool of retrieved sources and
    // `groundingSupports` as the mapping from answer segments to
    // `groundingChunkIndices`, which is the basis for inline citations.
    // Docs: https://ai.google.dev/gemini-api/docs/google-search
    // SDK: https://github.com/googleapis/js-genai/blob/main/src/types.ts
    const candidates = rawResponse.candidates as Array<{
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: {
            uri?: string
            title?: string
          }
        }>
        groundingSupports?: Array<{
          groundingChunkIndices?: number[]
        }>
      }
    }> | undefined
    const candidate = candidates?.[0]
    if (!candidate) return []

    const metadata = candidate.groundingMetadata
    if (!metadata) return []

    const chunks = metadata.groundingChunks
    if (!chunks) return []

    const indices = new Set<number>()
    for (const support of metadata.groundingSupports ?? []) {
      for (const index of support.groundingChunkIndices ?? []) {
        if (Number.isInteger(index) && index >= 0 && index < chunks.length) {
          indices.add(index)
        }
      }
    }

    const selectedChunks = indices.size > 0
      ? [...indices].map(index => chunks[index]!).filter(Boolean)
      : chunks

    const seen = new Set<string>()
    const sources: GroundingSource[] = []
    for (const chunk of selectedChunks) {
      if (!chunk.web?.uri || seen.has(chunk.web.uri)) continue
      seen.add(chunk.web.uri)
      sources.push({
        uri: chunk.web.uri,
        title: chunk.web.title ?? '',
      })
    }

    return sources
  } catch {
    return []
  }
}

function extractSearchQueriesFromRaw(rawResponse: Record<string, unknown>): string[] {
  try {
    const candidates = rawResponse.candidates as Array<{
      groundingMetadata?: {
        webSearchQueries?: string[]
      }
    }> | undefined
    const candidate = candidates?.[0]
    return candidate?.groundingMetadata?.webSearchQueries ?? []
  } catch {
    return []
  }
}

function extractCitedDomainsFromSources(groundingSources: GroundingSource[]): string[] {
  const domains = new Set<string>()

  for (const source of groundingSources) {
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
  const result = await withRetry(() =>
    client.models.generateContent({
      model,
      contents: prompt,
    }),
  )
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
        // Preserve support-to-chunk mappings so stored snapshots can be reparsed using
        // Google's documented citation model.
        // Docs: https://ai.google.dev/gemini-api/docs/google-search
        groundingSupports: c.groundingMetadata.groundingSupports,
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
