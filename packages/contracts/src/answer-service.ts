import { z } from 'zod'
import {
  CITATION_ELIGIBLE_RELATIONSHIPS,
  citationBasisFor,
  citationBasisSchema,
  costBasisSchema,
  disclosedModelKindSchema,
  locationGranularitySchema,
  retrievalObservabilitySchema,
  sourceRelationshipSchema,
  type CostBasis,
  type DisclosedModelKind,
  type LocationGranularity,
  type LocationStrength,
  type RetrievalObservability,
  type SourceRelationship,
} from './answer-evidence.js'
import { PROVIDER_NAMES, type ProviderQuotaPolicy } from './provider.js'
import { ProviderWorkflows, providerWorkflowSchema, type ProviderWorkflow } from './provider-eligibility.js'
import { profileRouteFamily, type ProviderRouteFamily } from './provider-routes.js'

/**
 * Hosted web-search answer services (a service that searches the web and
 * returns a grounded answer with sources). A vendor is described entirely by
 * one {@link AnswerServiceDescriptor}: everything shared (settings, routes,
 * eligibility, evidence, the catalog the UI, CLI and MCP render) is derived
 * from it, so adding a vendor never edits a shared surface.
 */

export const answerServiceExecutionSchema = z.enum(['sync', 'job'])
export type AnswerServiceExecution = z.infer<typeof answerServiceExecutionSchema>
export const answerServiceTransportSchema = z.enum(['json', 'sse'])
export type AnswerServiceTransport = z.infer<typeof answerServiceTransportSchema>
export const domainFilterStrengthSchema = z.enum(['hard', 'soft', 'none'])
export type DomainFilterStrength = z.infer<typeof domainFilterStrengthSchema>

/** One credential field. Answer services accept a key and nothing else: no base URL, no model. */
export interface AnswerServiceSettingField {
  key: 'apiKey'
  kind: 'secret'
  required: boolean
  /** Environment variable bootstrap reads, or null when the key comes from config.yaml only. */
  env: string | null
  label: string
}

export type AnswerServiceAuth =
  | { scheme: 'bearer' }
  | { scheme: 'header'; header: string }

/** A request that proves a key works without generating an answer or spending. */
export interface AnswerServiceKeyCheck {
  method: 'GET'
  path: string
}

export interface AnswerServiceProfileCapabilities {
  groundedAnswer: true
  /** Always false: an answer service searches and answers, it is not a text generator. */
  textGeneration: false
  structuredOutput: boolean
  evidence: {
    /** Relationships this profile's sources can carry, as the vendor documents them. */
    relationships: readonly SourceRelationship[]
    /** Whether citations carry upstream character spans. */
    spans: boolean
    retrievalObservability: RetrievalObservability
    /** Whether source URLs point at the page itself rather than a redirect. */
    directUrls: boolean
  }
  location: {
    granularity: LocationGranularity
    strength: LocationStrength | null
    /** A location the vendor documents applying when none is sent. */
    serviceDefault?: { country?: string } | null
  }
  filters: { includeDomains: DomainFilterStrength; excludeDomains: DomainFilterStrength }
  /** Longest query the service accepts. A longer query is refused, never truncated. */
  maxQueryChars: number | null
  disclosedModelKind: DisclosedModelKind
  /** What the response says about money: a reported amount, an estimate, or nothing. */
  costBasis: CostBasis
}

export interface AnswerServiceProfile {
  /** Route selection: results are stored under `<service>:<id>`. */
  id: string
  displayName: string
  /** One plain sentence for pickers. */
  description: string
  /** The vendor product this profile calls (for example an endpoint name). */
  product: string
  /** `job` profiles are declared for later; the shared factory refuses to run them this release. */
  execution: AnswerServiceExecution
  transport: AnswerServiceTransport
  /** Per-attempt deadline. */
  timeoutMs: number
  /** The model or tier name the request sends, or null when the request names none. */
  requestedServiceModel: string | null
  /** Frozen request knobs (effort, depth, result counts) recorded on every answer. */
  settings: Readonly<Record<string, string | number | boolean>>
  /** Bumped whenever the request shape for this profile changes. */
  requestPolicyVersion: string
  capabilities: AnswerServiceProfileCapabilities
  /** Workflows an explicit selection of this profile may run. Never used implicitly. */
  workflows: readonly ProviderWorkflow[]
}

export interface AnswerServiceDescriptor {
  /** Connection name and route prefix (`exa` for `exa:<profile>`). */
  id: string
  displayName: string
  keyUrl: string
  vendorDocsUrl: string
  /** Repository path of the vendor's docs page, for example `docs/providers/answer-services/<id>.md`. */
  docsPath: string
  auth: AnswerServiceAuth
  /** Fixed endpoint. Never user-settable, so a key can never be sent elsewhere. */
  baseUrl: string
  settings: {
    fields: readonly AnswerServiceSettingField[]
    allowBaseUrl: false
    allowModel: false
    keyCheck: AnswerServiceKeyCheck | null
  }
  defaultQuota: ProviderQuotaPolicy
  /** HTTP statuses the vendor documents as safe to retry for a paid request. */
  retry: { statuses: readonly number[] }
  /** Bumped whenever the response parser changes. */
  parserVersion: string
  profiles: readonly AnswerServiceProfile[]
}

const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/
const RESERVED_SERVICE_IDS = new Set<string>([...PROVIDER_NAMES, 'cdp', 'typesafe', 'canonry'])
const MAX_PROFILE_TIMEOUT_MS = 600_000

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isRetrySafeStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * Every rule a descriptor must satisfy, as plain-language problems (empty when
 * valid). One shared test runs it over every registered vendor, so a vendor
 * cannot opt out and no vendor folder repeats these checks.
 */
export function answerServiceDescriptorProblems(descriptor: AnswerServiceDescriptor): string[] {
  const problems: string[] = []
  const at = (message: string) => problems.push(`${descriptor.id}: ${message}`)
  if (!SERVICE_ID_PATTERN.test(descriptor.id)) at('id must be lowercase letters, digits and dashes')
  if (RESERVED_SERVICE_IDS.has(descriptor.id)) at('id collides with an existing provider name')
  if (!descriptor.displayName.trim()) at('displayName is required')
  if (!isHttpsUrl(descriptor.keyUrl)) at('keyUrl must be an https URL')
  if (!isHttpsUrl(descriptor.vendorDocsUrl)) at('vendorDocsUrl must be an https URL')
  if (!isHttpsUrl(descriptor.baseUrl)) at('baseUrl must be an https URL')
  if (!/^docs\/providers\/[a-z0-9/_-]+\.md$/.test(descriptor.docsPath)) at('docsPath must be a docs/providers/ Markdown page')
  if (descriptor.auth.scheme === 'header' && !/^[a-z0-9-]+$/i.test(descriptor.auth.header)) at('auth header must be a header name')
  if (!descriptor.parserVersion.trim()) at('parserVersion is required')
  const secrets = descriptor.settings.fields.filter(field => field.key === 'apiKey' && field.kind === 'secret')
  if (secrets.length !== 1 || descriptor.settings.fields.length !== 1) at('settings must declare exactly one apiKey secret field')
  for (const field of descriptor.settings.fields) {
    if (field.env !== null && !ENV_PATTERN.test(field.env)) at(`env "${field.env}" must be an uppercase variable name`)
  }
  if (descriptor.settings.allowBaseUrl !== false) at('base URL must not be user-settable')
  if (descriptor.settings.allowModel !== false) at('model must not be user-settable')
  if (descriptor.settings.keyCheck && !descriptor.settings.keyCheck.path.startsWith('/')) at('keyCheck path must start with /')
  for (const status of descriptor.retry.statuses) {
    if (!isRetrySafeStatus(status)) at(`retry status ${status} is not a throttle or server error`)
  }
  if (descriptor.profiles.length === 0) at('declare at least one profile')
  const seen = new Set<string>()
  for (const profile of descriptor.profiles) {
    const where = (message: string) => at(`profile ${profile.id}: ${message}`)
    if (!PROFILE_ID_PATTERN.test(profile.id)) where('id must be lowercase letters, digits, dots, dashes or underscores')
    if (seen.has(profile.id)) where('duplicate profile id')
    seen.add(profile.id)
    if (!profile.displayName.trim() || !profile.description.trim() || !profile.product.trim()) where('displayName, description and product are required')
    if (!profile.requestPolicyVersion.trim()) where('requestPolicyVersion is required')
    if (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs <= 0 || profile.timeoutMs > MAX_PROFILE_TIMEOUT_MS) where('timeoutMs must be a positive integer up to 600000')
    const capabilities = profile.capabilities
    if (capabilities.textGeneration !== false) where('an answer service is never a text generator')
    if (capabilities.groundedAnswer !== true) where('an answer service must return grounded answers')
    const relationships = capabilities.evidence.relationships
    if (relationships.length === 0 || new Set(relationships).size !== relationships.length) where('evidence relationships must be non-empty and unique')
    if (capabilities.evidence.spans && !relationships.includes('explicit-citation')) where('spans require explicit-citation sources')
    if (capabilities.location.granularity === 'none' && capabilities.location.strength !== null) where('a service that sends no location has no location strength')
    if (capabilities.maxQueryChars !== null && (!Number.isInteger(capabilities.maxQueryChars) || capabilities.maxQueryChars <= 0)) where('maxQueryChars must be a positive integer or null')
    if (new Set(profile.workflows).size !== profile.workflows.length) where('workflows must be unique')
    if (profile.workflows.includes(ProviderWorkflows['visibility-sweep'])) {
      if (!relationships.some(relationship => (CITATION_ELIGIBLE_RELATIONSHIPS as readonly string[]).includes(relationship))) {
        where('visibility-sweep needs sources the answer cites (answer-support or explicit-citation)')
      }
      if (profile.execution !== 'sync') where('visibility-sweep needs a synchronous profile')
    }
    if (profile.execution === 'job' && profile.transport === 'sse') where('a job profile does not stream')
  }
  return problems
}

/** The route family a descriptor declares: one route per profile. */
export function answerServiceRouteFamily(descriptor: Pick<AnswerServiceDescriptor, 'id' | 'profiles'>): ProviderRouteFamily {
  return profileRouteFamily(descriptor.id, descriptor.profiles.map(profile => profile.id))
}

export function answerServiceRouteName(serviceId: string, profileId: string): string {
  return `${serviceId}:${profileId}`
}

/** Credential-free description of one profile, the same for API, CLI, MCP and the dashboard. */
export const answerServiceProfileSummarySchema = z.object({
  id: z.string(),
  route: z.string(),
  displayName: z.string(),
  description: z.string(),
  product: z.string(),
  execution: answerServiceExecutionSchema,
  workflows: z.array(providerWorkflowSchema),
  evidence: z.object({
    relationships: z.array(sourceRelationshipSchema),
    citationBasis: citationBasisSchema,
    citationMeasurable: z.boolean(),
    spans: z.boolean(),
    retrievalObservability: retrievalObservabilitySchema,
  }),
  costBasis: costBasisSchema,
  locationGranularity: locationGranularitySchema,
  disclosedModelKind: disclosedModelKindSchema,
  maxQueryChars: z.number().int().positive().nullable(),
})
export type AnswerServiceProfileSummary = z.infer<typeof answerServiceProfileSummarySchema>

export function summarizeAnswerServiceProfile(serviceId: string, profile: AnswerServiceProfile): AnswerServiceProfileSummary {
  const citationBasis = citationBasisFor(profile.capabilities.evidence.relationships)
  return {
    id: profile.id,
    route: answerServiceRouteName(serviceId, profile.id),
    displayName: profile.displayName,
    description: profile.description,
    product: profile.product,
    execution: profile.execution,
    workflows: [...profile.workflows],
    evidence: {
      relationships: [...profile.capabilities.evidence.relationships],
      citationBasis,
      citationMeasurable: citationBasis !== 'none',
      spans: profile.capabilities.evidence.spans,
      retrievalObservability: profile.capabilities.evidence.retrievalObservability,
    },
    costBasis: profile.capabilities.costBasis,
    locationGranularity: profile.capabilities.location.granularity,
    disclosedModelKind: profile.capabilities.disclosedModelKind,
    maxQueryChars: profile.capabilities.maxQueryChars,
  }
}

/** A settings field as surfaced to clients (never a value). */
export const providerSettingsFieldSchema = z.object({
  key: z.literal('apiKey'),
  kind: z.literal('secret'),
  required: z.boolean(),
  env: z.string().nullable(),
  label: z.string(),
})
export type ProviderSettingsField = z.infer<typeof providerSettingsFieldSchema>

/**
 * Whether saving a key checks it. `verified-without-spending` uses a metadata
 * request; `saved-not-verified` means the vendor documents no free check, so
 * the first real request is the first proof.
 */
export const providerKeyCheckSchema = z.enum(['verified-without-spending', 'saved-not-verified'])
export type ProviderKeyCheck = z.infer<typeof providerKeyCheckSchema>

/** The credential-free catalog fields a host publishes for one service, read from its descriptor only. */
export function answerServiceCatalogFields(descriptor: AnswerServiceDescriptor): {
  profiles: AnswerServiceProfileSummary[]
  settingsFields: ProviderSettingsField[]
  keyCheck: ProviderKeyCheck
  keyUrl: string
  vendorDocsUrl: string
} {
  return {
    profiles: descriptor.profiles.map(profile => summarizeAnswerServiceProfile(descriptor.id, profile)),
    settingsFields: descriptor.settings.fields.map(field => ({ ...field })),
    keyCheck: descriptor.settings.keyCheck ? 'verified-without-spending' : 'saved-not-verified',
    keyUrl: descriptor.keyUrl,
    vendorDocsUrl: descriptor.vendorDocsUrl,
  }
}
