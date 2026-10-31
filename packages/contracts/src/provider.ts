import { z } from 'zod'
import type { GroundingSource, RetrievedSource } from './run.js'
import type { ModelDefinition, ProviderModelRegistry } from './models.js'
import { RetrievalStatuses, type RetrievalContract, type RetrievalStatus } from './retrieval.js'
import type { ProviderBatchCapability, ProviderBatchConfig, ProviderPricing, ProviderUsage, TrackedQueryRequest } from './provider-batch.js'
import type { AnswerEvidence } from './answer-evidence.js'
import type { ProviderCapabilities, ProviderKind } from './provider-eligibility.js'
import {
  DEFAULT_PROVIDER_ROUTE_FAMILIES,
  isConcreteProviderName,
  isRouteAvailable,
  OPENROUTER_ROUTE_FAMILY,
  routeConnectionName,
  routeSelection,
  type ProviderRouteFamily,
  type ResolvedProviderRoute,
} from './provider-routes.js'

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
export const PROVIDER_NAMES = ['gemini', 'openai', 'claude', 'perplexity', 'muse', 'local', 'openrouter', 'cdp:chatgpt'] as const
export const ProviderNames = {
  gemini: 'gemini',
  openai: 'openai',
  claude: 'claude',
  perplexity: 'perplexity',
  muse: 'muse',
  local: 'local',
  openrouter: 'openrouter',
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

export const API_PROVIDER_NAMES = ['gemini', 'openai', 'claude', 'perplexity', 'muse', 'local', 'openrouter'] as const
export const apiProviderNameSchema = z.string().min(1)
export type ApiProviderName = string

/**
 * OpenRouter sweep models offered first, one from the maker of each major
 * consumer answer engine. Pickers show only the ones OpenRouter's live
 * catalog still lists; every other model stays one search away.
 */
export const OPENROUTER_RECOMMENDED_SWEEP_MODELS = [
  { id: 'openai/gpt-6-luna', engine: 'ChatGPT' },
  { id: 'google/gemini-3.8-flash', engine: 'Gemini' },
  { id: 'anthropic/claude-sonnet-5.5', engine: 'Claude' },
] as const

/** The model an `openrouter:<publisher/model>` route pins, or undefined for anything else. */
export function openRouterRouteModel(name: string): string | undefined {
  return routeSelection(name, OPENROUTER_ROUTE_FAMILY)
}

export function isOpenRouterRoute(name: string): boolean {
  return openRouterRouteModel(name) !== undefined
}

export function openRouterRouteName(model: string): string {
  const route = `openrouter:${model.trim()}`
  if (!isOpenRouterRoute(route)) throw new Error('OpenRouter requires a fixed vendor/model slug.')
  return route
}

/**
 * Connection credentials, quotas and account holds are shared by its routes.
 * Pass the families of the adapters in scope; the default knows OpenRouter.
 */
export function providerConnectionName(name: string, families: readonly ProviderRouteFamily[] = DEFAULT_PROVIDER_ROUTE_FAMILIES): string {
  return routeConnectionName(name, families)
}

/** A route is available when its shared connection is available. */
export function isProviderAvailable(name: string, available: readonly string[], families: readonly ProviderRouteFamily[] = DEFAULT_PROVIDER_ROUTE_FAMILIES): boolean {
  return isRouteAvailable(name, available, families)
}

/** A routed connection alone (OpenRouter, an answer service) does not select a target for measurement. */
export function isSweepProvider(name: string, families: readonly ProviderRouteFamily[] = DEFAULT_PROVIDER_ROUTE_FAMILIES): boolean {
  return isConcreteProviderName(name, families)
}

/** The connection of a registered adapter, read from the family it declares. */
export function adapterConnectionName(adapter: Pick<ProviderAdapter, 'name' | 'routes'>): string {
  return adapter.routes ? routeConnectionName(adapter.name, [adapter.routes]) : providerConnectionName(adapter.name)
}

export type ProviderMode = 'api' | 'browser'

/** Check if a provider is browser-based (CDP) */
export function isBrowserProvider(name: string): boolean {
  return name.startsWith('cdp:')
}

/** All CDP target provider names (expand this array as new targets are added) */
export const CDP_TARGETS = ['cdp:chatgpt'] as const
export type CdpTarget = (typeof CDP_TARGETS)[number]

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
  /** Instance batch settings (config.yaml `providers.<name>.batch`). Absent = batch off. */
  batch?: ProviderBatchConfig
  /** Operator price overrides (config.yaml `providers.<name>.pricing`). */
  pricing?: ProviderPricing
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
  perplexity: {
    treatment: 'request-param',
    supportsLocationContext: true,
    description: 'Location sent as a structured `user_location` field on Perplexity’s web_search tool.',
  },
  muse: {
    treatment: 'request-param',
    supportsLocationContext: true,
    description: 'Location sent as a structured `user_location` field on Muse’s web_search tool.',
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

/** A search-tool location cannot apply when the provider reports no search. */
export function isSearchLocationIgnored(provider: ProviderName, retrievalStatus: RetrievalStatus): boolean {
  return retrievalStatus === RetrievalStatuses['not-used']
    && getProviderLocationHandling(provider).treatment === 'request-param'
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
  groundingSources: GroundingSource[]
  searchQueries: string[]
  /**
   * Pages the provider's searches listed or opened, never counted as cited.
   * Undefined or null when the provider does not report them.
   */
  retrievedSources?: RetrievedSource[] | null
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
  /**
   * Billable usage the provider reported for this answer. Undefined when the
   * response carries none (CDP, or a reconstruction from a stored row).
   */
  usage?: ProviderUsage
  /**
   * Why the provider stopped generating, verbatim from the response (Claude
   * `stop_reason`, OpenAI `status` / `incomplete_details.reason`, Gemini
   * `candidates[0].finishReason`). Stored so answers cut short (for example
   * Claude `pause_turn`) can be found later; never used to drop an answer.
   */
  stopReason?: string
  /**
   * The answer text, when the adapter extracts it while parsing (answer
   * services). Adapters that read it back from `rawResponse` in
   * `normalizeResult` leave it unset.
   */
  answerText?: string
  /**
   * Vendor-neutral evidence (source relationships, completion, identity,
   * usage basis). Set by answer services; absent for adapters that predate it.
   */
  evidence?: AnswerEvidence
  /**
   * Whether this answer's sources can say if a domain was cited. Absent means
   * true, as for every answer engine. False when the service never ties its
   * sources to the answer, so a citation state must not be recorded.
   */
  citationMeasurable?: boolean
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
  /** See {@link RawQueryResult.retrievedSources}. */
  retrievedSources?: RetrievedSource[] | null
  /** See {@link RawQueryResult.retrievalStatus}. */
  retrievalStatus: RetrievalStatus
  /** See {@link RawQueryResult.evidence}. */
  evidence?: AnswerEvidence
  /** See {@link RawQueryResult.citationMeasurable}. */
  citationMeasurable?: boolean
}

/** Whether an answer's citation state may be recorded. Answers without the flag always may. */
export function isCitationMeasurable(result: { citationMeasurable?: boolean }): boolean {
  return result.citationMeasurable !== false
}

/**
 * Thrown when an upstream returned something that is not a complete answer
 * (partial, failed or pending). It carries the evidence so a caller that
 * understands completion can keep it, while every other caller fails closed
 * instead of storing a cut-off or pending answer as a measured observation.
 *
 * `resumable` is true only for a pending upstream job the adapter can follow
 * later from its stored id (a job profile run by a job executor). A caller
 * that keeps saved work then waits on it instead of failing it, and never
 * submits it again. A pending handle from a synchronous request cannot be
 * followed, so it stays a failure that keeps its job id as evidence.
 */
export class IncompleteAnswerError extends Error {
  readonly resumable: boolean
  constructor(
    message: string,
    readonly evidence: AnswerEvidence,
    readonly answerText: string | null,
    readonly rawResponse: Record<string, unknown> | null,
    options: { resumable?: boolean } = {},
  ) {
    super(message)
    this.name = 'IncompleteAnswerError'
    // Without a job id there is nothing to follow, whatever the caller claims.
    this.resumable = options.resumable === true && evidence.completion.upstreamJobId !== null
  }
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
  /** Absent means an answer engine; see {@link ProviderKind}. */
  kind?: ProviderKind
  /** Absent means a full answer engine: generation plus every grounded workflow. */
  capabilities?: ProviderCapabilities
  /**
   * The route family this connection serves. Its bare name is then never a
   * measurement target; `<name>:<selection>` keys are.
   */
  routes?: ProviderRouteFamily
  /**
   * The adapter a resolved route runs as. Absent: the registry derives one
   * from this adapter with the route's selection pinned as its model.
   */
  forRoute?(route: ResolvedProviderRoute): ProviderAdapter
  /** The quota a connection starts with when config.yaml sets none. Absent: the shared default. */
  defaultQuota?: ProviderQuotaPolicy
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
  /** Read model metadata only; must never generate an answer or spend query quota. */
  listModels?(config: ProviderConfig, signal: AbortSignal): Promise<ModelDefinition[]>
  validateConfig(config: ProviderConfig): ProviderHealthcheckResult
  healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult>
  executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult>
  /**
   * The first half of `executeTrackedQuery`: the exact request it sends. An
   * adapter that implements it must make `executeTrackedQuery` equal to
   * build, call, `parseTrackedQueryResponse`, so a batch line and a sync call
   * ask the identical question and are read back the identical way.
   */
  buildTrackedQueryRequest?(input: TrackedQueryInput, config: ProviderConfig): TrackedQueryRequest
  /**
   * The second half: read one response body (in the shape the sync path
   * stores as `apiResponse`) into a result. `model` is the model the request
   * asked for. Throws where the sync path throws for the same body.
   */
  parseTrackedQueryResponse?(body: Record<string, unknown>, model: string): RawQueryResult
  /** Asynchronous batch dispatch, for providers whose API has one. */
  batch?: ProviderBatchCapability
  normalizeResult(raw: RawQueryResult): NormalizedQueryResult
  /**
   * Plain text generation. Optional: a hosted answer service always searches
   * and answers, so it has none. Check with `canGenerateText` before calling.
   */
  generateText?(prompt: string, config: ProviderConfig): Promise<string>
}
