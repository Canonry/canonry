import { z } from 'zod'

/**
 * Track 3 (Canonry Hosted) request / response shapes for the three cloud
 * bridge endpoints. Defined here rather than in `@ainyc/canonry-contracts`
 * because they're a tenant-side ingress contract for a sibling control-plane
 * — not a public SDK shape that needs to ride the OpenAPI catalog.
 *
 * The cloud-bridge endpoints aren't currently registered in OpenAPI: they're
 * gated by `CANONRY_ENABLE_CLOUD_BOOTSTRAP=1` and `X-Admin-Scope: 1`, and
 * publishing them would imply they're part of the supported public SDK
 * surface. Keep them out of `openapi.ts` until / unless that changes.
 */

/** Locale block — `{ country, language }` ISO-style identifiers. */
const localeSchema = z.object({
  country: z.string().min(2).max(8),
  language: z.string().min(2).max(16),
})

/**
 * Managed Google OAuth client metadata pushed by the control plane during
 * bootstrap. The tenant runtime does NOT exchange tokens with this client —
 * `POST /cloud/google/import-tokens` does that after the control plane has
 * brokered the OAuth dance. We just persist the client id and the
 * tenant-facing redirect URL so `canonry doctor` can surface what the
 * tenant *thinks* it's wired against if a connection later goes sideways.
 */
const managedOAuthSchema = z.object({
  google_client_id: z.string().min(1),
  google_client_secret: z.string().min(1),
  google_callback_url: z.string().url(),
})

export const cloudBootstrapRequestSchema = z.object({
  tenant_id: z.string().min(1),
  account_id: z.string().min(1),
  plan: z.string().min(1),
  control_plane_callback_url: z.string().url(),
  webhook_secret: z.string().min(1),
  default_locale: localeSchema,
  managed_oauth: managedOAuthSchema,
})
export type CloudBootstrapRequest = z.infer<typeof cloudBootstrapRequestSchema>

export const cloudBootstrapResponseSchema = z.object({
  canonry_version: z.string(),
  bootstrap_completed_at: z.string(),
  webhook_attached: z.boolean(),
})
export type CloudBootstrapResponse = z.infer<typeof cloudBootstrapResponseSchema>

export const cloudImportGoogleTokensRequestSchema = z.object({
  project_slug: z.string().min(1),
  connection_type: z.enum(['gsc', 'ga4']),
  property_ref: z.string().min(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expiry: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  account_email: z.string().min(1),
})
export type CloudImportGoogleTokensRequest = z.infer<typeof cloudImportGoogleTokensRequestSchema>

export const cloudImportGoogleTokensResponseSchema = z.object({
  imported: z.literal(true),
  domain: z.string(),
  connection_type: z.enum(['gsc', 'ga4']),
  property_ref: z.string().nullable(),
})
export type CloudImportGoogleTokensResponse = z.infer<typeof cloudImportGoogleTokensResponseSchema>

export const cloudImportBingKeyRequestSchema = z.object({
  project_slug: z.string().min(1),
  api_key: z.string().min(1),
  site_url: z.string().min(1),
})
export type CloudImportBingKeyRequest = z.infer<typeof cloudImportBingKeyRequestSchema>

export const cloudImportBingKeyResponseSchema = z.object({
  imported: z.literal(true),
  domain: z.string(),
  site_url: z.string().nullable(),
})
export type CloudImportBingKeyResponse = z.infer<typeof cloudImportBingKeyResponseSchema>
