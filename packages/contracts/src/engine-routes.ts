import { z } from 'zod'
import { providerQuotaPolicySchema } from './provider.js'

/**
 * A gateway is intentionally described by an open protocol, not its brand.
 * Presets only fill safe defaults; the persisted contract stays portable.
 */
export const engineConnectionPresetSchema = z.enum([
  'openrouter',
  'litellm',
  'vercel-ai-gateway',
  'custom-openai-compatible',
])
export type EngineConnectionPreset = z.infer<typeof engineConnectionPresetSchema>

export const engineConnectionProtocolSchema = z.literal('openai-compatible')
export type EngineConnectionProtocol = z.infer<typeof engineConnectionProtocolSchema>

const stableIdSchema = z.string().trim().min(1).max(128).regex(
  /^\w[\w.:-]*$/,
  'Must be a stable URL-safe identifier',
)

const modelIdSchema = z.string().trim().min(1).max(512)

function canonicalEndpoint(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error('Connection baseUrl must be an HTTP(S) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Connection baseUrl must be an HTTP(S) URL')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Connection baseUrl must not contain credentials, a query, or a fragment')
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${pathname}`
}

/**
 * An execution-identity policy may record an endpoint but never its URL
 * credentials, query, or fragment. Native provider config predates the
 * stricter gateway endpoint schema, so normalize defensively here rather than
 * making identity hashing a secret-bearing serialization path.
 */
function canonicalExecutionEndpoint(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return undefined
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return undefined
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${pathname}`
}

const endpointSchema = z.string().trim().min(1).superRefine((value, ctx) => {
  try {
    canonicalEndpoint(value)
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid endpoint' })
  }
})

/** Defaults are intentionally small: no gateway dependency is special at runtime. */
export const ENGINE_CONNECTION_PRESET_DEFAULTS: Readonly<Record<Exclude<EngineConnectionPreset, 'custom-openai-compatible'>, {
  protocol: EngineConnectionProtocol
  baseUrl: string
}>> = {
  openrouter: { protocol: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' },
  litellm: { protocol: 'openai-compatible', baseUrl: 'http://localhost:4000' },
  'vercel-ai-gateway': { protocol: 'openai-compatible', baseUrl: 'https://ai-gateway.vercel.sh/v1' },
}

const engineConnectionBaseSchema = z.object({
  id: stableIdSchema,
  label: z.string().trim().min(1).max(128),
  preset: engineConnectionPresetSchema,
  protocol: engineConnectionProtocolSchema.default('openai-compatible'),
  /** Stored only in instance config. Never put this value in a public DTO. */
  apiKey: z.string().min(1).optional(),
  quota: providerQuotaPolicySchema,
}).strict()

export const engineConnectionConfigSchema = engineConnectionBaseSchema.extend({
  baseUrl: endpointSchema,
})
export type EngineConnectionConfig = z.output<typeof engineConnectionConfigSchema>

const engineConnectionUpsertFieldsSchema = engineConnectionBaseSchema.omit({ id: true }).extend({
  baseUrl: endpointSchema.optional(),
})

function requireCustomConnectionEndpoint(
  input: { preset: EngineConnectionPreset; baseUrl?: string },
  ctx: z.RefinementCtx,
): void {
  if (input.preset === 'custom-openai-compatible' && !input.baseUrl) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'baseUrl is required for a custom OpenAI-compatible connection' })
  }
}

/** Request body for a connection PUT. Its stable id is always the path id. */
export const engineConnectionUpsertInputSchema = engineConnectionUpsertFieldsSchema.superRefine(requireCustomConnectionEndpoint)
export type EngineConnectionUpsertInput = z.input<typeof engineConnectionUpsertInputSchema>

/** Internal full input after the HTTP layer adds the server-owned path id. */
export const engineConnectionInputSchema = engineConnectionBaseSchema.extend({
  baseUrl: endpointSchema.optional(),
}).superRefine(requireCustomConnectionEndpoint)
export type EngineConnectionInput = z.input<typeof engineConnectionInputSchema>

/** Resolve a preset once, then persist the fully explicit generic connection. */
export function normalizeEngineConnection(input: EngineConnectionInput): EngineConnectionConfig {
  const parsed = engineConnectionInputSchema.parse(input)
  const defaults = parsed.preset === 'custom-openai-compatible'
    ? undefined
    : ENGINE_CONNECTION_PRESET_DEFAULTS[parsed.preset]
  const baseUrl = canonicalEndpoint(parsed.baseUrl ?? defaults?.baseUrl ?? '')
  return engineConnectionConfigSchema.parse({
    ...parsed,
    protocol: parsed.protocol,
    baseUrl,
  })
}

/** True when an update would send a connection credential to a new endpoint. */
export function engineConnectionEndpointChanged(
  existing: Pick<EngineConnectionConfig, 'protocol' | 'baseUrl'> | undefined,
  input: EngineConnectionInput,
): boolean {
  if (!existing) return false
  const next = normalizeEngineConnection(input)
  return existing.baseUrl !== next.baseUrl
}

/**
 * Settings updates are credential-safe by default: a redacted GET followed by
 * a PUT must not erase an existing secret simply because the client cannot
 * echo it back. That preservation is safe only while the canonical endpoint
 * is unchanged; repointing the connection requires a replacement secret.
 */
export function upsertEngineConnection(
  existing: EngineConnectionConfig | undefined,
  input: EngineConnectionInput,
): EngineConnectionConfig {
  if (input.apiKey === undefined && existing?.apiKey && engineConnectionEndpointChanged(existing, input)) {
    throw new Error(
      'Changing an engine connection endpoint requires an explicit apiKey; the existing credential is not forwarded to a different endpoint.',
    )
  }
  return normalizeEngineConnection({
    ...input,
    ...(input.apiKey === undefined && existing?.apiKey
      ? { apiKey: existing.apiKey }
      : {}),
  })
}

/** Credential-safe settings response. */
export const engineConnectionPublicDtoSchema = z.object({
  id: stableIdSchema,
  label: z.string(),
  preset: engineConnectionPresetSchema,
  protocol: engineConnectionProtocolSchema,
  baseUrl: endpointSchema,
  quota: providerQuotaPolicySchema,
  secretConfigured: z.boolean(),
}).strict()
export type EngineConnectionPublicDto = z.output<typeof engineConnectionPublicDtoSchema>

export function buildEngineRoutePublicDto(connection: EngineConnectionConfig): EngineConnectionPublicDto {
  return engineConnectionPublicDtoSchema.parse({
    id: connection.id,
    label: connection.label,
    preset: connection.preset,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    quota: connection.quota,
    secretConfigured: Boolean(connection.apiKey),
  })
}

/**
 * A configured generic OpenAI-compatible route is text-only until server code
 * owns a concrete evidence adapter. A client/config value can never promote
 * itself to measurement-ready simply by setting booleans.
 */
export const engineRouteCapabilitiesSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text-only') }).strict(),
  z.object({
    kind: z.literal('verified-measurement'),
    retrieval: z.literal(true),
    citations: z.literal(true),
    location: z.literal(true),
    servedModel: z.literal(true),
    fallback: z.literal('disabled'),
  }).strict(),
])
export type EngineRouteCapabilities = z.output<typeof engineRouteCapabilitiesSchema>

export const engineRouteSourceSchema = z.enum(['configured', 'implicit-native', 'verified-adapter'])
export type EngineRouteSource = z.output<typeof engineRouteSourceSchema>

export const engineRouteConfigSchema = z.object({
  id: stableIdSchema,
  label: z.string().trim().min(1).max(128),
  connectionId: stableIdSchema,
  modelId: modelIdSchema,
  revision: z.number().int().positive(),
  source: engineRouteSourceSchema.default('configured'),
  capabilities: engineRouteCapabilitiesSchema,
}).strict()
export type EngineRouteConfig = z.output<typeof engineRouteConfigSchema>

export const engineConnectionModelCatalogItemSchema = z.object({
  /** Model id exactly as the configured gateway disclosed it. */
  id: modelIdSchema,
  /** Optional presentation metadata; never a request capability claim. */
  displayName: z.string().trim().min(1).max(512).optional(),
  /** Optional upstream/provider namespace from the catalog response. */
  provider: z.string().trim().min(1).max(256).optional(),
}).strict()
export type EngineConnectionModelCatalogItem = z.output<typeof engineConnectionModelCatalogItemSchema>

/**
 * A models read is discovery only. `unavailable` is intentionally a normal
 * typed response so callers keep the manual model-id path usable when a
 * gateway does not implement `/models` or is temporarily unavailable.
 */
export const engineConnectionModelCatalogResponseSchema = z.object({
  connectionId: stableIdSchema,
  state: z.enum(['available', 'unavailable']),
  manualModelIdAllowed: z.literal(true),
  fetchedAt: z.string().datetime(),
  models: z.array(engineConnectionModelCatalogItemSchema).max(500),
}).strict()
export type EngineConnectionModelCatalogResponse = z.output<typeof engineConnectionModelCatalogResponseSchema>

/**
 * Public settings writers do not get to set identity, revision, source, or
 * evidence capability. The host derives all four from trusted state.
 */
export const engineRouteUpsertInputSchema = z.object({
  label: z.string().trim().min(1).max(128),
  connectionId: stableIdSchema,
  modelId: modelIdSchema,
}).strict()
export type EngineRouteUpsertInput = z.input<typeof engineRouteUpsertInputSchema>

export const engineRouteReadinessSchema = z.object({
  state: z.enum(['unavailable', 'text-ready', 'measurement-ready']),
  measurementReady: z.boolean(),
}).strict()
export type EngineRouteReadiness = z.output<typeof engineRouteReadinessSchema>

/** Credential-free route metadata safe for viewer and scoped-project reads. */
export const engineRouteSummaryDtoSchema = z.object({
  id: stableIdSchema,
  label: z.string(),
  modelId: modelIdSchema,
  revision: z.number().int().positive(),
  source: engineRouteSourceSchema,
  readiness: engineRouteReadinessSchema,
}).strict()
export type EngineRouteSummaryDto = z.output<typeof engineRouteSummaryDtoSchema>

export const engineRouteSummaryResponseSchema = z.object({
  routes: z.array(engineRouteSummaryDtoSchema),
}).strict()
export type EngineRouteSummaryResponse = z.output<typeof engineRouteSummaryResponseSchema>

/**
 * A capability declaration is not evidence proof. Only native or server-owned
 * adapters may return measurement-ready; user-configured gateway routes stay
 * text-ready even if a hand-edited config claims otherwise.
 */
export function engineRouteReadiness(
  route: EngineRouteConfig,
  options: { connectionAvailable?: boolean } = {},
): EngineRouteReadiness {
  if (options.connectionAvailable === false) {
    return { state: 'unavailable', measurementReady: false }
  }
  const verifiedOwner = route.source === 'implicit-native' || route.source === 'verified-adapter'
  const verified = route.capabilities.kind === 'verified-measurement'
  return verifiedOwner && verified
    ? { state: 'measurement-ready', measurementReady: true }
    : { state: 'text-ready', measurementReady: false }
}

export function buildEngineRouteSummaryDto(
  route: EngineRouteConfig,
  options: { connectionAvailable?: boolean } = {},
): EngineRouteSummaryDto {
  return engineRouteSummaryDtoSchema.parse({
    id: route.id,
    label: route.label,
    modelId: route.modelId,
    revision: route.revision,
    source: route.source,
    readiness: engineRouteReadiness(route, options),
  })
}

export function assertEngineRouteCanMeasure(route: EngineRouteConfig): void {
  if (engineRouteReadiness(route).measurementReady) return
  throw new Error(
    `Engine route "${route.id}" does not prove retrieval, citation, location, and served-model evidence. ` +
    'It is available for text work only and cannot run an answer-visibility sweep.',
  )
}

function canonicalRouteMaterial(route: EngineRouteConfig): string {
  return JSON.stringify({
    connectionId: route.connectionId,
    modelId: route.modelId,
    source: route.source,
    capabilities: route.capabilities,
  })
}

/**
 * The non-secret policy material an execution identity fingerprints. A route
 * revision is the primary audit handle; this fingerprint makes the reason for
 * its boundary independently inspectable without serializing credentials.
 */
export function canonicalEngineRoutePolicyJson(
  route: EngineRouteConfig,
  connection?: Pick<EngineConnectionConfig, 'id' | 'protocol' | 'baseUrl'>,
  /** Native execution endpoint, sanitized before it becomes policy material. */
  nativeExecutionEndpoint?: string,
): string {
  const executionEndpoint = canonicalExecutionEndpoint(nativeExecutionEndpoint)
  return JSON.stringify({
    connection: connection
      ? { id: connection.id, protocol: connection.protocol, baseUrl: connection.baseUrl }
      : { id: route.connectionId },
    ...(executionEndpoint ? { executionEndpoint } : {}),
    source: route.source,
    capabilities: route.capabilities,
  })
}

/** Preserve a route identity across cosmetic edits; bump on an execution change. */
export function nextEngineRouteRevision(existing: EngineRouteConfig, next: EngineRouteConfig): number {
  return canonicalRouteMaterial(existing) === canonicalRouteMaterial(next)
    ? existing.revision
    : existing.revision + 1
}

/**
 * Derive a readable ID for a newly-created route. Callers persist the output;
 * subsequent edits preserve that stored ID and only change its revision.
 */
export function deriveEngineRouteId(connectionId: string, modelId: string): string {
  const source = `${connectionId}\u0000${modelId}`
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const slug = source
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 108) || 'route'
  return `route:${slug}:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Existing providers remain runnable through stable virtual routes. */
export function buildImplicitNativeEngineRoute(input: {
  provider: string
  displayName: string
  defaultModel: string
  /**
   * Evidence is explicitly supplied by the host's native adapter registry.
   * Do not infer retrieval/citations/served-model proof from a location flag.
   */
  capabilities?: EngineRouteCapabilities
}): EngineRouteConfig {
  const provider = stableIdSchema.parse(input.provider)
  return engineRouteConfigSchema.parse({
    id: `native:${provider}`,
    label: input.displayName,
    connectionId: `native:${provider}`,
    modelId: input.defaultModel,
    revision: 1,
    source: 'implicit-native',
    capabilities: input.capabilities ?? { kind: 'text-only' },
  })
}

/** One real upstream credential/budget per connection, irrespective of route. */
export function engineConnectionGateKey(connection: Pick<EngineConnectionConfig, 'id'>): string {
  return `connection:${connection.id}`
}
