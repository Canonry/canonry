import { z } from 'zod'
import type { GroundingSource } from './run.js'
import type { ProviderModelRegistry } from './models.js'

export const providerQuotaPolicySchema = z.object({
  maxConcurrency: z.number().int().positive(),
  maxRequestsPerMinute: z.number().int().positive(),
  maxRequestsPerDay: z.number().int().positive(),
})

export type ProviderQuotaPolicy = z.infer<typeof providerQuotaPolicySchema>

/**
 * Provider name is now a free-form string validated at runtime against
 * registered adapters. These constants are kept for backward compatibility
 * but are NOT the source of truth — each adapter self-declares its name.
 */
export const PROVIDER_NAMES = ['gemini', 'openai', 'claude', 'perplexity', 'local', 'cdp:chatgpt'] as const
export const ProviderNames = {
  gemini: 'gemini',
  openai: 'openai',
  claude: 'claude',
  perplexity: 'perplexity',
  local: 'local',
  cdpChatgpt: 'cdp:chatgpt',
} as const
export const providerNameSchema = z.string().min(1)
export type ProviderName = string

/**
 * Per-project model overrides. Values are normalized at the contract boundary
 * so every writer persists a compact, non-blank model id; the route layer
 * then validates the provider key and adapter-owned naming rule.
 */
export const providerModelsSchema = z.record(z.string(), z.string().trim().min(1))
export type ProviderModels = z.infer<typeof providerModelsSchema>

export const API_PROVIDER_NAMES = ['gemini', 'openai', 'claude', 'perplexity', 'local'] as const
export const apiProviderNameSchema = z.string().min(1)
export type ApiProviderName = string

export type ProviderMode = 'api' | 'browser'

/** Check if a provider is browser-based (CDP) */
export function isBrowserProvider(name: string): boolean {
  return name.startsWith('cdp:')
}

/** All CDP target provider names (expand this array as new targets are added) */
export const CDP_TARGETS = ['cdp:chatgpt'] as const
export type CdpTarget = (typeof CDP_TARGETS)[number]

/**
 * Normalize a user-supplied string to a lowercased provider name.
 * Returns the trimmed, lowercased string, or undefined for empty input.
 * Callers should validate the result against the set of registered adapters.
 */
export function parseProviderName(input: string): string | undefined {
  const lower = input.trim().toLowerCase()
  return lower || undefined
}

/**
 * Parse a provider input that may be 'cdp' (expands to all CDP targets)
 * or a single provider name. Returns an array of resolved provider names.
 */
export function resolveProviderInput(input: string): string[] {
  const lower = input.trim().toLowerCase()
  if (lower === 'cdp') {
    return [...CDP_TARGETS]
  }
  return lower ? [lower] : []
}

export interface ProviderConfig {
  provider: string
  apiKey?: string
  baseUrl?: string
  model?: string
  quotaPolicy: ProviderQuotaPolicy
  /** CDP WebSocket endpoint (e.g. "ws://localhost:9222" or "ws://host.tailnet:9222") */
  cdpEndpoint?: string
  /** Vertex AI GCP project ID (Gemini provider only) */
  vertexProject?: string
  /** Vertex AI region, e.g. "us-central1" (Gemini provider only) */
  vertexRegion?: string
  /** Path to service account JSON for Vertex AI auth (falls back to ADC) */
  vertexCredentials?: string
}

export interface LocationContext {
  label: string
  city: string
  region: string
  country: string
  timezone?: string
}

export const locationContextSchema = z.object({
  label: z.string().min(1),
  city: z.string().min(1),
  region: z.string().min(1),
  country: z.string().length(2),
  timezone: z.string().optional(),
})

/**
 * How a provider applies a `LocationContext` to the LLM call. Surfaced in
 * the report so non-technical readers can tell whether their location config
 * actually shaped the answer they're looking at.
 *
 * - `prompt`        — appended to the query text the model receives
 * - `request-param` — sent as a structured field on the search tool
 * - `browser-geo`   — implicit via the browser session's IP/geo (CDP)
 * - `ignored`       — provider does not consume location at all
 */
export type ProviderLocationTreatment = 'prompt' | 'request-param' | 'browser-geo' | 'ignored'

export interface ProviderLocationHandling {
  treatment: ProviderLocationTreatment
  /** One-sentence description suitable for a non-technical reader. */
  description: string
}

const PROVIDER_LOCATION_HANDLING: Record<string, ProviderLocationHandling> = {
  gemini: {
    treatment: 'prompt',
    description: 'Location appended to the query text the Gemini model receives.',
  },
  perplexity: {
    treatment: 'prompt',
    description: 'Location appended to the query text the Perplexity model receives.',
  },
  local: {
    treatment: 'prompt',
    description: 'Location appended to the system message sent to the local model.',
  },
  openai: {
    treatment: 'request-param',
    description: 'Location sent as a structured `user_location` field on OpenAI’s web_search tool.',
  },
  claude: {
    treatment: 'request-param',
    description: 'Location sent as a structured `user_location` field on Anthropic’s web_search_20250305 tool.',
  },
  'cdp:chatgpt': {
    treatment: 'browser-geo',
    description: 'CDP relies on the browser session’s own geolocation; canonry’s configured location is not forwarded.',
  },
}

const UNKNOWN_PROVIDER_HANDLING: ProviderLocationHandling = {
  treatment: 'ignored',
  description: 'No documented location handling for this provider — assume the configured location was not applied.',
}

export function getProviderLocationHandling(provider: string): ProviderLocationHandling {
  return PROVIDER_LOCATION_HANDLING[provider] ?? UNKNOWN_PROVIDER_HANDLING
}

export interface TrackedQueryInput {
  query: string
  canonicalDomains: string[]
  competitorDomains: string[]
  location?: LocationContext
}

export interface RawQueryResult {
  provider: string
  rawResponse: Record<string, unknown>
  model: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** Filesystem path to cropped screenshot PNG (CDP providers only) */
  screenshotPath?: string
}

export interface NormalizedQueryResult {
  provider: string
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}

export interface ProviderHealthcheckResult {
  ok: boolean
  provider: string
  message: string
  model?: string
}

export interface ProviderAdapter {
  name: string
  /** Human-readable display name (e.g. "Gemini", "Perplexity") */
  displayName: string
  /** Whether this is an API-based or browser-based (CDP) provider */
  mode: ProviderMode
  /** Model registry with defaults, validation, and known models */
  modelRegistry: ProviderModelRegistry
  /** URL where users can obtain an API key (shown in UI) */
  keyUrl?: string
  validateConfig(config: ProviderConfig): ProviderHealthcheckResult
  healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult>
  executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult>
  normalizeResult(raw: RawQueryResult): NormalizedQueryResult
  generateText(prompt: string, config: ProviderConfig): Promise<string>
}
