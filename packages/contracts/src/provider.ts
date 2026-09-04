import { z } from 'zod'
import type { GroundingSource } from './run.js'
import type { ProviderModelRegistry } from './models.js'
import type { RetrievalContract, RetrievalStatus } from './retrieval.js'

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
  /**
   * Shared credential/rate-limit identity. Native providers omit this and use
   * their provider name; multiple gateway routes set the same connection id.
   */
  connectionId?: string
  /**
   * False only for a text-only route. Undefined preserves every pre-route
   * native provider as runnable for answer-visibility sweeps.
   */
  measurementReady?: boolean
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
  /**
   * Whether the configured location actually reaches this provider's request.
   * True for prompt-borne and structured-parameter treatments alike — in both
   * the model saw the location. False where the provider never receives it
   * (browser geolocation, or no handling at all), so a stored row must not
   * claim the answer was measured from that place.
   */
  supportsLocationContext: boolean
  /** One-sentence description suitable for a non-technical reader. */
  description: string
}

const PROVIDER_LOCATION_HANDLING: Record<string, ProviderLocationHandling> = {
  gemini: {
    treatment: 'prompt',
    supportsLocationContext: true,
    description: 'Location appended to the query text the Gemini model receives.',
  },
  perplexity: {
    treatment: 'prompt',
    supportsLocationContext: true,
    description: 'Location appended to the query text the Perplexity model receives.',
  },
  local: {
    treatment: 'prompt',
    supportsLocationContext: true,
    description: 'Location appended to the system message sent to the local model.',
  },
  openai: {
    treatment: 'request-param',
    supportsLocationContext: true,
    description: 'Location sent as a structured `user_location` field on OpenAI’s web_search tool.',
  },
  claude: {
    treatment: 'request-param',
    supportsLocationContext: true,
    description: 'Location sent as a structured `user_location` field on Anthropic’s web_search_20250305 tool.',
  },
  'cdp:chatgpt': {
    treatment: 'browser-geo',
    supportsLocationContext: false,
    description: 'CDP relies on the browser session’s own geolocation; canonry’s configured location is not forwarded.',
  },
}

const UNKNOWN_PROVIDER_HANDLING: ProviderLocationHandling = {
  treatment: 'ignored',
  supportsLocationContext: false,
  description: 'No documented location handling for this provider — assume the configured location was not applied.',
}

export function getProviderLocationHandling(provider: string): ProviderLocationHandling {
  return PROVIDER_LOCATION_HANDLING[provider] ?? UNKNOWN_PROVIDER_HANDLING
}

/**
 * Whether a stored row may claim it was measured from the requested place.
 *
 * Reads the adapter's own declaration and nothing else. An adapter that says
 * nothing claims nothing: an undeclared provider is treated as location-blind,
 * because the cost of a wrong `true` is a report asserting geography that
 * never reached the model.
 */
export function providerSupportsLocationContext(adapter: { supportsLocationContext?: boolean }): boolean {
  return adapter.supportsLocationContext === true
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
  /**
   * The model identity the provider reported serving, verbatim as it appeared in the
   * response (e.g. `gpt-5.6-sol` when `model` was configured as `gpt-5.6`). Undefined
   * when the response disclosed no model identity — CDP scrapes the web UI and has
   * none. NEVER derived from config: `model` is what we asked for, `servedModel` is
   * what we got, and the whole point of the field is that the two can disagree.
   */
  servedModel?: string
  /**
   * The upstream/provider identity the response itself disclosed, if any.
   * This is intentionally separate from `provider`, which is Canonry's
   * requested adapter or route. Never infer it from a configured gateway,
   * route label, or model id; absence is honest and stays undefined.
   */
  servedProvider?: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /**
   * Whether this provider retrieved for this answer. Required, not optional:
   * a search-policy change must never be able to produce an unmarked snapshot,
   * so every adapter is forced to state a value rather than silently omit one.
   * `unknown` is the correct answer where detection is not implemented.
   */
  retrievalStatus: RetrievalStatus
  /** The search policy this request was constructed under. */
  retrievalContract: RetrievalContract
  /** Filesystem path to cropped screenshot PNG (CDP providers only) */
  screenshotPath?: string
}

/**
 * Normalize a provider-reported model identity for the `servedModel` field.
 *
 * Accepts only a non-empty string taken from the provider's own response: trims
 * surrounding whitespace and returns undefined for a missing, non-string, empty, or
 * whitespace-only value. Callers MUST pass the response field (`model`,
 * `modelVersion`, …) and never the configured model — an absent disclosure has to
 * stay absent rather than silently echo what we requested.
 */
export function normalizeServedModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export interface NormalizedQueryResult {
  provider: string
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** See {@link RawQueryResult.retrievalStatus}. */
  retrievalStatus: RetrievalStatus
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
  /**
   * Whether this adapter actually forwards a `LocationContext` to the model —
   * in the prompt or as a request parameter. Required, not optional, for the
   * same reason `retrievalStatus` is: an adapter that quietly drops the
   * location must state so, rather than letting a snapshot inherit a claim
   * nobody checked. Keep in step with `getProviderLocationHandling`.
   */
  supportsLocationContext: boolean
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
