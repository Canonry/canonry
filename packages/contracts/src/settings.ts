import { z } from 'zod'
import { providerQuotaPolicySchema } from './provider.js'
import { providerKindSchema, providerWorkflowSchema } from './provider-eligibility.js'
import { providerSelectionKindSchema } from './provider-routes.js'
import { answerServiceProfileSummarySchema, providerKeyCheckSchema, providerSettingsFieldSchema } from './answer-service.js'
import { providerBatchConfigSchema, providerPricingSchema } from './provider-batch.js'

export const providerQuotaFieldSchema = providerQuotaPolicySchema.keyof()
export const ProviderQuotaFields = providerQuotaFieldSchema.enum
export type ProviderQuotaField = z.infer<typeof providerQuotaFieldSchema>

export const providerSettingsResetSchema = z.object({
  model: z.literal(true).optional(),
  baseUrl: z.literal(true).optional(),
  apiKey: z.literal(true).optional(),
  quota: z.array(providerQuotaFieldSchema).min(1).optional(),
}).strict().refine(value => value.model || value.baseUrl || value.apiKey || value.quota?.length, 'Select at least one setting to reset')

/** Omitted fields preserve saved values; reset removes an override rather than saving today's default. */
export const providerSettingsUpdateRequestSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  quota: providerQuotaPolicySchema.partial().strict().refine(value => Object.keys(value).length > 0, 'Select at least one quota field').optional(),
  reset: providerSettingsResetSchema.optional(),
  expectedRevision: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.apiKey === undefined && value.baseUrl === undefined && value.model === undefined && value.quota === undefined && value.reset === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Supply at least one provider setting' })
  }
  if (value.reset?.model && value.model !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Cannot set and reset model together' })
  if (value.reset?.baseUrl && value.baseUrl !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'Cannot set and reset endpoint together' })
  if (value.reset?.apiKey && value.apiKey !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKey'], message: 'Cannot set and reset API key together' })
  for (const key of value.reset?.quota ?? []) {
    if (value.quota?.[key] !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['quota', key], message: 'Cannot set and reset a quota field together' })
  }
})
export type ProviderSettingsUpdateRequest = z.infer<typeof providerSettingsUpdateRequestSchema>

/** Concurrency guard for an inspected connection and its current project references. */
export const providerDisconnectRequestSchema = z.object({ expectedImpactRevision: z.string().min(1).optional() }).strict()
export type ProviderDisconnectRequest = z.infer<typeof providerDisconnectRequestSchema>

/**
 * What testing a saved provider connection showed. `connected`: a live request
 * reached the provider with the saved settings and succeeded. `failed`: the
 * provider refused the settings, could not be reached, or did not answer in
 * time; `message` says why. `not-verified`: the settings are saved, but the
 * provider documents no free check, so the first real request is the first proof.
 */
export const providerConnectionTestStatusSchema = z.enum(['connected', 'failed', 'not-verified'])
export const ProviderConnectionTestStatuses = providerConnectionTestStatusSchema.enum
export type ProviderConnectionTestStatus = z.infer<typeof providerConnectionTestStatusSchema>

/** What one connection test returned, shared by the test response and the connection's stored last test. */
const providerConnectionTestOutcomeShape = {
  status: providerConnectionTestStatusSchema,
  ok: z.boolean().describe('False only when status is failed. A not-verified connection is ok but unproven, so read status.'),
  message: z.string().describe('The provider\'s own result or refusal, with credentials redacted.'),
  model: z.string().nullable().describe('The model this connection runs, as its check reported it, or null when the check names none.'),
  checkedAt: z.string().describe('When the check finished (ISO 8601).'),
  durationMs: z.number().int().nonnegative(),
}
const okMatchesStatus = (result: { ok: boolean; status: ProviderConnectionTestStatus }): boolean =>
  result.ok === (result.status !== ProviderConnectionTestStatuses.failed)
const OK_MATCHES_STATUS = 'ok is false exactly when status is failed'

/** `POST /settings/providers/{name}/test`. Credential-free: the server redacts `message` before it is returned. */
export const providerConnectionTestResultDtoSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  ...providerConnectionTestOutcomeShape,
}).refine(okMatchesStatus, OK_MATCHES_STATUS)
export type ProviderConnectionTestResultDto = z.infer<typeof providerConnectionTestResultDtoSchema>

/** The latest test of a connection, kept only while the connection's active settings are the ones it checked. */
export const providerConnectionLastTestDtoSchema = z.object(providerConnectionTestOutcomeShape).refine(okMatchesStatus, OK_MATCHES_STATUS)
export type ProviderConnectionLastTestDto = z.infer<typeof providerConnectionLastTestDtoSchema>

/** Host-owned, credential-free configuration. Secrets and credential-file paths never enter this DTO. */
export const providerConnectionConfigDtoSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  kind: providerKindSchema,
  mode: z.enum(['api', 'browser']),
  configured: z.boolean(),
  revision: z.string(),
  apiKeyConfigured: z.boolean(),
  baseUrl: z.string().nullable().describe('Saved endpoint override, or null when the adapter default is selected or a private endpoint is withheld. Consult capabilities and blockers before editing.'),
  model: z.string().nullable(),
  defaultModel: z.string().nullable(),
  effectiveModel: z.string().nullable(),
  quota: z.object({ defaults: providerQuotaPolicySchema, overrides: providerQuotaPolicySchema.partial(), effective: providerQuotaPolicySchema }),
  capabilities: z.object({
    apiKey: z.boolean(), clearApiKey: z.boolean(), baseUrl: z.boolean(), resetBaseUrl: z.boolean(), model: z.boolean(),
    quota: z.boolean(), disconnect: z.boolean(), reload: z.boolean(),
  }),
  hostManaged: z.object({
    vertex: z.object({ project: z.string(), region: z.string().nullable(), credentialsConfigured: z.boolean() }).nullable(),
    batch: providerBatchConfigSchema.nullable(),
    pricing: providerPricingSchema.nullable(),
  }),
  hostUses: z.array(z.string()),
  blockers: z.array(z.object({ code: z.string(), message: z.string(), runIds: z.array(z.string()), batchIds: z.array(z.string()) })),
  lastTest: providerConnectionLastTestDtoSchema.nullable().optional()
    .describe('The latest connection test of the active settings: null when none has run since they last changed (a new key, endpoint, model, Vertex setting or CDP endpoint, or a disconnect, hides an earlier test). Absent from hosts that keep no test history.'),
})
export type ProviderConnectionConfigDto = z.infer<typeof providerConnectionConfigDtoSchema>

export const providerConnectionUsageSourceSchema = z.enum(['project', 'schedule', 'measurement-plan', 'measurement-draft'])
export const ProviderConnectionUsageSources = providerConnectionUsageSourceSchema.enum
export type ProviderConnectionUsageSource = z.infer<typeof providerConnectionUsageSourceSchema>
export const providerConnectionSettingsDtoSchema = providerConnectionConfigDtoSchema.extend({
  usage: z.object({
    projectCount: z.number().int().nonnegative(),
    projects: z.array(z.object({
      name: z.string(), displayName: z.string(), providers: z.array(z.string()), sources: z.array(providerConnectionUsageSourceSchema),
    })),
    unknown: z.object({
      projectCount: z.number().int().positive(),
      projects: z.array(z.object({ name: z.string(), displayName: z.string(), sources: z.array(providerConnectionUsageSourceSchema) })),
    }).optional().describe('Present only when a project\'s saved measurement plan or draft could not be read. The listed sources of those projects (a schedule follows its unreadable plan) may also reference this connection; they are never counted in projectCount or listed in projects.'),
  }),
  impactRevision: z.string(),
})
export type ProviderConnectionSettingsDto = z.infer<typeof providerConnectionSettingsDtoSchema>

/**
 * Per-provider summary entry surfaced by `GET /settings`. Mirrors the
 * server-side `ProviderSummaryEntry` interface in `api-routes/src/settings.ts`,
 * promoted to a Zod schema so the spec/SDK stay in sync.
 *
 * Fields stay loose-ish (lots of `.optional()`) because the registry is
 * pluggable — adapters can omit fields they don't expose (e.g. local
 * provider has no `keyUrl`).
 */
export const providerSummaryEntryDtoSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  keyUrl: z.string().optional(),
  modelHint: z.string().optional(),
  model: z.string().optional(),
  /**
   * The adapter's built-in default model. Surfaced so the UI and CLI can show
   * the effective model even when no explicit `model` override is configured.
   */
  defaultModel: z.string().optional(),
  configured: z.boolean(),
  quota: providerQuotaPolicySchema.optional(),
  /** Whether Vertex AI is configured for this provider (Gemini only). */
  vertexConfigured: z.boolean().optional(),
  /** Absent means an answer engine. */
  kind: providerKindSchema.optional(),
})
export type ProviderSummaryEntryDto = z.infer<typeof providerSummaryEntryDtoSchema>

/** Optional local-install identity pins; they select the install, never a file to read. */
export const providerReloadRequestSchema = z.object({
  configPath: z.string().min(1).max(4096).optional(),
  databasePath: z.string().min(1).max(4096).optional(),
}).strict().refine(
  input => (input.configPath === undefined) === (input.databasePath === undefined),
  'configPath and databasePath must be supplied together',
)
export type ProviderReloadRequest = z.infer<typeof providerReloadRequestSchema>

/**
 * `error.details.reason` on a reload `VALIDATION_ERROR`. `install-identity-mismatch`:
 * the `configPath` + `databasePath` pair names a different install than the
 * one this server runs, so nothing was reloaded. Callers branch on this value,
 * never on the message.
 */
export const providerReloadErrorReasonSchema = z.enum(['install-identity-mismatch'])
export type ProviderReloadErrorReason = z.infer<typeof providerReloadErrorReasonSchema>
export const ProviderReloadErrorReasons = providerReloadErrorReasonSchema.enum

export const providerReloadResponseDtoSchema = z.object({
  reloaded: z.literal(true),
  providers: z.array(providerSummaryEntryDtoSchema),
})
export type ProviderReloadResponseDto = z.infer<typeof providerReloadResponseDtoSchema>


/**
 * `error.details.reason` when a connection test is refused before any provider
 * request. `provider-not-configured`: the connection has no saved settings to
 * test. `provider-test-in-progress`: a test of the same connection is still
 * running on this server; wait for its result instead of stacking another.
 * Callers branch on this value, never on the message.
 */
export const providerConnectionTestErrorReasonSchema = z.enum(['provider-not-configured', 'provider-test-in-progress'])
export const ProviderConnectionTestErrorReasons = providerConnectionTestErrorReasonSchema.enum
export type ProviderConnectionTestErrorReason = z.infer<typeof providerConnectionTestErrorReasonSchema>

/** Credential-free adapter metadata used for project-scoped model controls. */
export const providerCatalogEntryDtoSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  mode: z.enum(['api', 'browser']),
  modelConfigurable: z.boolean(),
  defaultModel: z.string(),
  knownModels: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    tier: z.enum(['flagship', 'standard', 'fast', 'economy']),
  })).default([]),
  modelValidationPattern: z.object({ source: z.string(), flags: z.string() }),
  modelValidationHint: z.string(),
  /** Absent means an answer engine. Hosted web-search answer services are `answer-service`. */
  kind: providerKindSchema.optional(),
  /** The connection that owns this entry's key and quota (its own name for a connection). */
  connection: z.string().optional(),
  /**
   * On a routed connection: what its route keys select (`model` for OpenRouter,
   * `profile` for an answer service). The connection itself is never a target.
   */
  selectionKind: providerSelectionKindSchema.nullable().optional(),
  /** Answer-service profiles: all of them on the connection, the pinned one on a route. */
  profiles: z.array(answerServiceProfileSummarySchema).optional(),
  /** Workflows an explicit selection of this entry may run. Absent means every workflow. */
  workflows: z.array(providerWorkflowSchema).optional(),
  /** Whether this entry can act as a plain text generator (analysis, query generation). */
  textGeneration: z.boolean().optional(),
  /** Credential fields the connection accepts. Answer services take a key and nothing else. */
  settingsFields: z.array(providerSettingsFieldSchema).optional(),
  keyCheck: providerKeyCheckSchema.optional(),
  keyUrl: z.string().optional(),
  vendorDocsUrl: z.string().optional(),
})
export type ProviderCatalogEntryDto = z.infer<typeof providerCatalogEntryDtoSchema>

/**
 * Lightweight Google/Bing settings summary — both currently expose only
 * `configured`, but the wrapper object exists so the spec can grow new
 * fields (e.g. account email, redirect URI) without breaking consumers.
 */
export const integrationSettingsSummaryDtoSchema = z.object({
  configured: z.boolean(),
})
export type IntegrationSettingsSummaryDto = z.infer<typeof integrationSettingsSummaryDtoSchema>

/**
 * Why `GET /settings` returned `providerConnectionsUnavailable` instead of
 * `providerConnections`. `config-unreadable`: the host could not read its
 * saved provider configuration (for example a YAML or schema mistake in a
 * hand edit); repair it on the host, then reload provider connections.
 * `internal-error`: the list could not be built for another reason; the server
 * log has the detail. Also `error.details.reason` when a provider connection
 * read or write is refused for the same cause. Branch on this, never on a message.
 */
export const providerConnectionsUnavailableReasonSchema = z.enum(['config-unreadable', 'internal-error'])
export const ProviderConnectionsUnavailableReasons = providerConnectionsUnavailableReasonSchema.enum
export type ProviderConnectionsUnavailableReason = z.infer<typeof providerConnectionsUnavailableReasonSchema>

export const providerConnectionsUnavailableDtoSchema = z.object({
  reason: providerConnectionsUnavailableReasonSchema,
  /** Operator guidance. Never contains a credential, a configuration line, or a file path. */
  message: z.string(),
})
export type ProviderConnectionsUnavailableDto = z.infer<typeof providerConnectionsUnavailableDtoSchema>

/**
 * Response shape for `GET /settings`. Powers the dashboard's settings page
 * and the `setup_state` telemetry derived from provider presence.
 */
export const settingsDtoSchema = z.object({
  providers: z.array(providerSummaryEntryDtoSchema).default([]),
  providerCatalog: z.array(providerCatalogEntryDtoSchema).default([]),
  /** Present only for an install administrator on a host exposing saved provider configuration. */
  providerConnections: z.array(providerConnectionSettingsDtoSchema).optional(),
  providerConnectionsUnavailable: providerConnectionsUnavailableDtoSchema.optional()
    .describe('Present instead of providerConnections, for the same install administrator, when the host could not build that list. Every other settings field is still returned.'),
  google: integrationSettingsSummaryDtoSchema,
  bing: integrationSettingsSummaryDtoSchema,
})
export type SettingsDto = z.infer<typeof settingsDtoSchema>
