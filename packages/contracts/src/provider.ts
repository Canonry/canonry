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
export const providerNameSchema = z.string().min(1)
export type ProviderName = string

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
