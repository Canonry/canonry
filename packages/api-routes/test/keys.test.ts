import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, apiKeys, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

/** The wildcard root key — satisfies the keys.write gate. */
const ROOT_KEY = 'cnry_roottoken'
/** A read-only key — must be rejected from the write routes (403). */
const READ_KEY = 'cnry_readtoken'

function seedKey(name: string, raw: string, scopes: string[]): string {
  const id = crypto.randomUUID()
  db.insert(apiKeys).values({
    id,
    name,
    keyHash: hashApiKey(raw),
    keyPrefix: raw.slice(0, 9),
    scopes,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-test-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedKey('root', ROOT_KEY, ['*'])
  seedKey('reader', READ_KEY, ['read'])

  // Auth ENABLED — these tests exercise the scope gate and revocation, both of
  // which require the auth plugin to attach `request.apiKey`.
  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function authed(method: 'GET' | 'POST', url: string, token: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body } : {}),
  })
}

describe('API key management routes', () => {
  it('POST /keys mints a cnry_-prefixed key with a matching keyPrefix', async () => {
    const res = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: 'ci-bot' })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { key: string; keyPrefix: string; name: string; scopes: string[]; id: string }
    expect(dto.key).toMatch(/^cnry_[0-9a-f]{32}$/)
    expect(dto.keyPrefix).toBe(dto.key.slice(0, 9))
    expect(dto.name).toBe('ci-bot')
    // No explicit scopes → defaults to ['*'].
    expect(dto.scopes).toEqual(['*'])
  })

  it('GET /keys omits keyHash AND plaintext and includes a newly created key', async () => {
    const create = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: 'listed-key' })
    const created = create.json() as { id: string; key: string }

    const res = await authed('GET', '/api/v1/keys', ROOT_KEY)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { keys: Array<Record<string, unknown>> }

    // The new key is present.
    const found = body.keys.find(k => k.id === created.id)
    expect(found).toBeDefined()
    expect(found!.name).toBe('listed-key')
    expect(found!.keyPrefix).toBe(created.key.slice(0, 9))

    // No row exposes the hash or the plaintext token, anywhere in the list.
    for (const k of body.keys) {
      expect(k).not.toHaveProperty('keyHash')
      expect(k).not.toHaveProperty('key')
    }
    // Defense in depth: the raw token never appears in the serialized response.
    expect(res.body).not.toContain(created.key)
  })

  it('POST /keys honors explicit scopes', async () => {
    const res = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: 'scoped', scopes: ['read', 'keys.write'] })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { scopes: string[] }).scopes).toEqual(['read', 'keys.write'])
  })

  it('POST /keys rejects an empty name with a validation error', async () => {
    const res = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: '' })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('revoke sets revokedAt and the raw key is rejected by authPlugin afterward', async () => {
    // Mint a fresh key, then revoke it.
    const create = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: 'to-revoke' })
    const created = create.json() as { id: string; key: string }

    const revoke = await authed('POST', `/api/v1/keys/${created.id}/revoke`, ROOT_KEY)
    expect(revoke.statusCode).toBe(200)
    expect((revoke.json() as { revokedAt: string | null }).revokedAt).toBeTruthy()

    // The revoked raw key must now be rejected. Re-use the full app (it has the
    // global error handler that serializes AppError into the structured
    // envelope) and hit any authenticated route with the revoked token.
    const rejected = await authed('GET', '/api/v1/keys', created.key)
    expect(rejected.statusCode).toBe(401)
    expect((rejected.json() as { error: { code: string } }).error.code).toBe('AUTH_INVALID')
  })

  it('revoke is idempotent — revoking an already-revoked key returns it unchanged', async () => {
    const create = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: 'twice' })
    const created = create.json() as { id: string }

    const first = await authed('POST', `/api/v1/keys/${created.id}/revoke`, ROOT_KEY)
    const firstRevokedAt = (first.json() as { revokedAt: string }).revokedAt

    const second = await authed('POST', `/api/v1/keys/${created.id}/revoke`, ROOT_KEY)
    expect(second.statusCode).toBe(200)
    expect((second.json() as { revokedAt: string }).revokedAt).toBe(firstRevokedAt)
  })

  it('cannot revoke the key you are currently authenticating with', async () => {
    // Find the root key's own id from the list, then try to revoke it with itself.
    const list = await authed('GET', '/api/v1/keys', ROOT_KEY)
    const rootRow = (list.json() as { keys: Array<{ id: string; name: string }> }).keys.find(k => k.name === 'root')!

    const res = await authed('POST', `/api/v1/keys/${rootRow.id}/revoke`, ROOT_KEY)
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string; message: string } }).error.code).toBe('VALIDATION_ERROR')
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/currently authenticating/i)
  })

  it('revoke returns 404 for an unknown key id', async () => {
    const res = await authed('POST', '/api/v1/keys/does-not-exist/revoke', ROOT_KEY)
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('POST /keys without the keys.write scope returns 403', async () => {
    const res = await authed('POST', '/api/v1/keys', READ_KEY, { name: 'nope' })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('POST /keys/:id/revoke without the keys.write scope returns 403', async () => {
    // Mint a victim key with the root, then try to revoke it with the read key.
    const create = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: 'victim' })
    const created = create.json() as { id: string }
    const res = await authed('POST', `/api/v1/keys/${created.id}/revoke`, READ_KEY)
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('a wildcard ["*"] key satisfies the keys.write gate', async () => {
    const res = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: 'wildcard-ok' })
    expect(res.statusCode).toBe(200)
  })

  it('GET /keys is allowed for a non-keys.write key (ungated list)', async () => {
    const res = await authed('GET', '/api/v1/keys', READ_KEY)
    expect(res.statusCode).toBe(200)
    expect(Array.isArray((res.json() as { keys: unknown[] }).keys)).toBe(true)
  })
})
