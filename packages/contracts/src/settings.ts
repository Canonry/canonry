import { z } from 'zod'
import { providerQuotaPolicySchema } from './provider.js'
import { providerKindSchema, providerWorkflowSchema } from './provider-eligibility.js'
import { providerSelectionKindSchema } from './provider-routes.js'
import { answerServiceProfileSummarySchema, providerKeyCheckSchema, providerSettingsFieldSchema } from './answer-service.js'

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
 * Response shape for `GET /settings`. Powers the dashboard's settings page
 * and the `setup_state` telemetry derived from provider presence.
 */
export const settingsDtoSchema = z.object({
  providers: z.array(providerSummaryEntryDtoSchema).default([]),
  providerCatalog: z.array(providerCatalogEntryDtoSchema).default([]),
  google: integrationSettingsSummaryDtoSchema,
  bing: integrationSettingsSummaryDtoSchema,
})
export type SettingsDto = z.infer<typeof settingsDtoSchema>
