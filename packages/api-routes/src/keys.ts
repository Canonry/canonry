import crypto from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { apiKeys, projects } from '@ainyc/canonry-db'
import {
  createApiKeyRequestSchema,
  forbidden,
  isReadOnlyKey,
  notFound,
  validationError,
  type ApiKeyDto,
  type CreatedApiKeyDto,
} from '@ainyc/canonry-contracts'
import { hashApiKey, requireScope } from './auth.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'

/**
 * Scope required to mint or revoke API keys.
 *
 * Minting a key is a privilege-granting operation: a caller who can create
 * keys can hand themselves a `['*']` key and bypass every other gate. Revoking
 * a key cuts off another principal's access. Both are gated behind
 * `keys.write`. The default key written by `canonry init` carries `['*']`,
 * which satisfies this gate by wildcard; narrower delegate keys must opt in
 * explicitly. Listing keys is ungated (any valid bearer) because the list DTO
 * exposes only safe metadata — never a hash or plaintext.
 */
export const KEYS_WRITE_SCOPE = 'keys.write'

/** Map a raw `api_keys` row to the SAFE public DTO (never exposes `keyHash`). */
function toApiKeyDto(row: typeof apiKeys.$inferSelect): ApiKeyDto {
  const scopes = Array.isArray(row.scopes) ? row.scopes : []
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes,
    projectId: row.projectId ?? null,
    readOnly: isReadOnlyKey(scopes),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? null,
    revokedAt: row.revokedAt ?? null,
  }
}

export async function keysRoutes(app: FastifyInstance) {
  // List all keys — ungated (any valid bearer). Returns SAFE metadata only.
  app.get('/keys', async () => {
    const rows = app.db
      .select()
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt))
      .all()
    return { keys: rows.map(toApiKeyDto) }
  })

  // Introspect the CURRENT key — the one that authenticated this request.
  // Ungated read (a read-only key can call it; GET passes the read-only gate).
  // Lets a caller (or the MCP adapter at startup) discover whether its
  // configured key is read-only without listing every key on the instance.
  app.get('/keys/self', async (request) => {
    // `request.apiKey` is attached by authPlugin on every non-skip-path
    // request. Absent only when auth is skipped (test harness) — surface a
    // clear 404 rather than a confusing miss.
    const id = request.apiKey?.id
    if (!id) {
      throw notFound('API key', 'self')
    }
    const row = app.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()
    if (!row) {
      throw notFound('API key', id)
    }
    return toApiKeyDto(row)
  })

  // Create a key — requires the keys.write scope. Mints a `cnry_…` token,
  // stores only its sha256 hash + prefix, and returns the plaintext ONCE.
  app.post('/keys', async (request) => {
    requireScope(request, KEYS_WRITE_SCOPE)

    const parsed = createApiKeyRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid API key request', { issues: parsed.error.issues })
    }
    const { name, scopes, projectId } = parsed.data

    // A project-scoped key may only mint keys for ITS OWN project — minting an
    // unscoped key (projectId omitted) or a sibling-scoped one would let a
    // scoped key escalate out of its own boundary.
    const requesterProjectId = request.apiKey?.projectId
    if (requesterProjectId && projectId !== requesterProjectId) {
      throw forbidden('A project-scoped key can only mint keys scoped to its own project.')
    }

    // A project-scoped key must reference a real project — validate before
    // minting so a typo cannot create an orphan key that 403s every request.
    if (projectId) {
      const proj = app.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()
      if (!proj) {
        throw notFound('Project', projectId)
      }
    }

    const raw = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const keyHash = hashApiKey(raw)
    const keyPrefix = raw.slice(0, 9)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const effectiveScopes = scopes ?? ['*']

    app.db.transaction((tx) => {
      tx.insert(apiKeys).values({
        id,
        name,
        keyHash,
        keyPrefix,
        scopes: effectiveScopes,
        projectId: projectId ?? null,
        createdAt: now,
      }).run()
      // Audit the creation. Never log the plaintext or the hash — only the
      // safe identifiers (prefix + scopes) so the trail is useful without
      // leaking key material.
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'api-key.created',
        entityType: 'api-key',
        entityId: id,
        diff: { name, keyPrefix, scopes: effectiveScopes, projectId: projectId ?? null },
      }))
    })

    const dto: CreatedApiKeyDto = {
      id,
      name,
      keyPrefix,
      scopes: effectiveScopes,
      projectId: projectId ?? null,
      readOnly: isReadOnlyKey(effectiveScopes),
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
      key: raw,
    }
    return dto
  })

  // Revoke a key — requires the keys.write scope. Sets `revokedAt`; revocation
  // takes effect immediately because `authPlugin` rejects any key whose
  // `revokedAt` is set on every request.
  app.post<{ Params: { id: string } }>('/keys/:id/revoke', async (request) => {
    requireScope(request, KEYS_WRITE_SCOPE)
    const { id } = request.params

    const row = app.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()
    if (!row) {
      throw notFound('API key', id)
    }

    // Footgun guard: revoking the key you're currently authenticating with
    // would lock the caller out mid-session. Refuse and tell them to use a
    // different key.
    if (request.apiKey?.id === id) {
      throw validationError('Cannot revoke the API key you are currently authenticating with')
    }

    // Idempotent: already revoked → return as-is, no second audit entry.
    if (row.revokedAt) {
      return toApiKeyDto(row)
    }

    const now = new Date().toISOString()
    app.db.transaction((tx) => {
      tx.update(apiKeys).set({ revokedAt: now }).where(eq(apiKeys.id, id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'api-key.revoked',
        entityType: 'api-key',
        entityId: id,
        diff: { name: row.name, keyPrefix: row.keyPrefix },
      }))
    })

    return toApiKeyDto({ ...row, revokedAt: now })
  })
}
