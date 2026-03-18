import { z } from 'zod'
import type { GroundingSource } from './run.js'

export const providerQuotaPolicySchema = z.object({
  maxConcurrency: z.number().int().positive(),
  maxRequestsPerMinute: z.number().int().positive(),
  maxRequestsPerDay: z.number().int().positive(),
})

export type ProviderQuotaPolicy = z.infer<typeof providerQuotaPolicySchema>

export const PROVIDER_NAMES = ['gemini', 'openai', 'claude', 'local', 'cdp:chatgpt'] as const
export const providerNameSchema = z.enum(PROVIDER_NAMES)
export type ProviderName = z.infer<typeof providerNameSchema>

/** Classify providers by surface: API-based or browser-based (CDP) */
export const PROVIDER_MODE: Record<ProviderName, 'api' | 'browser'> = {
  gemini: 'api',
  openai: 'api',
  claude: 'api',
  local: 'api',
  'cdp:chatgpt': 'browser',
}
export type ProviderMode = 'api' | 'browser'

/** Check if a provider is browser-based (CDP) */
export function isBrowserProvider(name: ProviderName): boolean {
  return PROVIDER_MODE[name] === 'browser'
}

/** All CDP target provider names (expand this array as new targets are added) */
export const CDP_TARGETS = ['cdp:chatgpt'] as const
export type CdpTarget = (typeof CDP_TARGETS)[number]

/** Canonical display labels for each provider */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  claude: 'Claude',
  local: 'Local',
  'cdp:chatgpt': 'ChatGPT (Browser)',
}

/**
 * Normalize a user-supplied string to a valid ProviderName or expand
 * the shorthand 'cdp' to all CDP targets.
 * Accepts any casing (e.g. "Gemini", "OPENAI", "cdp:chatgpt").
 * Returns undefined if the string doesn't match any known provider.
 */
export function parseProviderName(input: string): ProviderName | undefined {
  const lower = input.trim().toLowerCase()
  return PROVIDER_NAMES.includes(lower as ProviderName) ? (lower as ProviderName) : undefined
}

/**
 * Parse a provider input that may be 'cdp' (expands to all CDP targets)
 * or a single provider name. Returns an array of resolved provider names.
 */
export function resolveProviderInput(input: string): ProviderName[] {
  const lower = input.trim().toLowerCase()
  if (lower === 'cdp') {
    return [...CDP_TARGETS]
  }
  const parsed = parseProviderName(lower)
  return parsed ? [parsed] : []
}

export interface ProviderConfig {
  provider: ProviderName
  apiKey?: string
  baseUrl?: string
  model?: string
  quotaPolicy: ProviderQuotaPolicy
  /** CDP WebSocket endpoint (e.g. "ws://localhost:9222" or "ws://host.tailnet:9222") */
  cdpEndpoint?: string
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

export interface TrackedQueryInput {
  keyword: string
  canonicalDomains: string[]
  competitorDomains: string[]
  location?: LocationContext
}

export interface RawQueryResult {
  provider: ProviderName
  rawResponse: Record<string, unknown>
  model: string
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /** Filesystem path to cropped screenshot PNG (CDP providers only) */
  screenshotPath?: string
}

export interface NormalizedQueryResult {
  provider: ProviderName
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
}

export interface ProviderHealthcheckResult {
  ok: boolean
  provider: ProviderName
  message: string
  model?: string
}

export interface ProviderAdapter {
  name: ProviderName
  validateConfig(config: ProviderConfig): ProviderHealthcheckResult
  healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult>
  executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult>
  normalizeResult(raw: RawQueryResult): NormalizedQueryResult
  generateText(prompt: string, config: ProviderConfig): Promise<string>
}
