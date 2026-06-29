import { z } from 'zod'

/**
 * SAFE, public-facing metadata for an API key. This is the ONLY shape the API
 * ever returns for an existing key. It deliberately omits `keyHash` (the stored
 * sha256) and the plaintext token — those must never leave the server. The raw
 * token is surfaced exactly once, at creation time, via `createdApiKeyDtoSchema`.
 */
export const apiKeyDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** First 9 chars of the raw token (`cnry_` + 4 hex). Safe to display. */
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  /**
   * The project this key is scoped to, or `null` for a full-instance key. A
   * scoped key may only read/write its own project (enforced server-side).
   */
  projectId: z.string().nullable(),
  /**
   * Server-derived convenience flag: `true` when this key is read-only (carries
   * the `read` scope and no write-granting scope), in which case the API rejects
   * every write HTTP method for it. Derived from `scopes` via `isReadOnlyKey`
   * — surfaces don't recompute it (see the UI/CLI parity rule). Additive field.
   */
  readOnly: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
})

export type ApiKeyDto = z.infer<typeof apiKeyDtoSchema>

/** List response for `GET /keys`. */
export const apiKeyListDtoSchema = z.object({
  keys: z.array(apiKeyDtoSchema),
})

export type ApiKeyListDto = z.infer<typeof apiKeyListDtoSchema>

/** Request body for `POST /keys`. */
export const createApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(100),
  /**
   * Scopes granted to the new key. Omit to default to `['*']` (full access,
   * what `canonry init` writes for the root key). When provided it must be a
   * non-empty list — an empty array would mint a key that can do nothing.
   */
  scopes: z.array(z.string()).min(1).optional(),
  /**
   * Bind the new key to a SINGLE project (by project id). Omit for a
   * full-instance key (the default). A scoped key may only read/write that
   * project; the server validates the id exists at creation time.
   */
  projectId: z.string().optional(),
})

export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>

/**
 * Response for `POST /keys` — the safe metadata PLUS the plaintext `key`.
 *
 * The `key` field is the only time the raw `cnry_…` token is ever returned.
 * It is not stored in plaintext and cannot be recovered later, so the caller
 * must persist it on receipt.
 */
export const createdApiKeyDtoSchema = apiKeyDtoSchema.extend({
  key: z.string(),
})

export type CreatedApiKeyDto = z.infer<typeof createdApiKeyDtoSchema>
