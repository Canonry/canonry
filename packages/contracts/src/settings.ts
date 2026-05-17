import { z } from 'zod'
import { providerQuotaPolicySchema } from './provider.js'

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
  configured: z.boolean(),
  quota: providerQuotaPolicySchema.optional(),
  /** Whether Vertex AI is configured for this provider (Gemini only). */
  vertexConfigured: z.boolean().optional(),
})
export type ProviderSummaryEntryDto = z.infer<typeof providerSummaryEntryDtoSchema>

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
  google: integrationSettingsSummaryDtoSchema,
  bing: integrationSettingsSummaryDtoSchema,
})
export type SettingsDto = z.infer<typeof settingsDtoSchema>
