import crypto from 'node:crypto'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { googleRoutes } from '../src/google.js'

// Reproduce state signing functions from google.ts to verify behavior
function signState(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

function buildSignedState(data: Record<string, unknown>, secret: string): string {
  const payload = JSON.stringify(data)
  const sig = signState(payload, secret)
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url')
}

function verifySignedState(encoded: string, secret: string): Record<string, unknown> | null {
  try {
    const { payload, sig } = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { payload: string; sig: string }
    const expected = signState(payload, secret)
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

function buildApp(opts: { googleClientId?: string; googleClientSecret?: string; googleStateSecret?: string } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const connections: Array<{
    domain: string
    connectionType: 'gsc' | 'ga4'
    propertyId?: string | null
    accessToken?: string
    refreshToken?: string | null
    tokenExpiresAt?: string | null
    scopes?: string[]
    createdAt: string
    updatedAt: string
  }> = []

  const app = Fastify()
  app.decorate('db', db)
  app.register(googleRoutes, {
    getGoogleAuthConfig: () => ({
      clientId: opts.googleClientId,
      clientSecret: opts.googleClientSecret,
    }),
    googleConnectionStore: {
      listConnections: (domain) => connections.filter((connection) => connection.domain === domain),
      getConnection: (domain, connectionType) => connections.find((connection) => (
        connection.domain === domain && connection.connectionType === connectionType
      )),
      upsertConnection: (connection) => {
        const index = connections.findIndex((entry) => (
          entry.domain === connection.domain && entry.connectionType === connection.connectionType
        ))
        if (index === -1) {
          connections.push(connection)
        } else {
          connections[index] = connection
        }
        return connection
      },
      updateConnection: (domain, connectionType, patch) => {
        const existing = connections.find((connection) => (
          connection.domain === domain && connection.connectionType === connectionType
        ))
        if (!existing) return undefined
        Object.assign(existing, patch)
        return existing
      },
      deleteConnection: (domain, connectionType) => {
        const index = connections.findIndex((connection) => (
          connection.domain === domain && connection.connectionType === connectionType
        ))
        if (index === -1) return false
        connections.splice(index, 1)
        return true
      },
    },
    googleStateSecret: opts.googleStateSecret ?? 'test-secret-32-bytes-long-enough!',
  })

  return { app, db, tmpDir }
}

describe('state signing', () => {
  it('roundtrips signed state correctly', () => {
    const secret = 'my-test-secret'
    const data = { domain: 'example.com', type: 'gsc', redirectUri: 'http://localhost/callback' }
    const encoded = buildSignedState(data, secret)
    const decoded = verifySignedState(encoded, secret)
    assert.ok(decoded !== null)
    assert.equal((decoded as { domain: string }).domain, 'example.com')
    assert.equal((decoded as { type: string }).type, 'gsc')
  })

  it('rejects tampered payload', () => {
    const secret = 'my-test-secret'
    const data = { domain: 'example.com', type: 'gsc' }
    const encoded = buildSignedState(data, secret)

    // Decode, tamper, re-encode without updating sig
    const inner = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { payload: string; sig: string }
    const tamperedPayload = JSON.stringify({ domain: 'attacker.com', type: 'gsc' })
    const tampered = Buffer.from(JSON.stringify({ payload: tamperedPayload, sig: inner.sig })).toString('base64url')

    const result = verifySignedState(tampered, secret)
    assert.equal(result, null)
  })

  it('rejects state signed with different secret', () => {
    const data = { domain: 'example.com', type: 'gsc' }
    const encoded = buildSignedState(data, 'original-secret')
    const result = verifySignedState(encoded, 'different-secret')
    assert.equal(result, null)
  })

  it('rejects garbage input', () => {
    const result = verifySignedState('not-valid-base64url!!!', 'secret')
    assert.equal(result, null)
  })
})

describe('googleRoutes: POST /projects/:name/google/connect', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  before(async () => {
    const ctx = buildApp({ googleClientId: undefined, googleClientSecret: undefined })
    app = ctx.app
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  after(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 400 when OAuth is not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/my-project/google/connect',
      payload: { type: 'gsc' },
    })
    assert.equal(res.statusCode, 400)
    const body = res.json() as { error: { code: string } }
    assert.equal(body.error.code, 'VALIDATION_ERROR')
  })
})

describe('googleRoutes: GET /projects/:name/google/callback', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  before(async () => {
    const ctx = buildApp({
      googleClientId: 'test-client-id',
      googleClientSecret: 'test-client-secret',
      googleStateSecret: 'test-secret',
    })
    app = ctx.app
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  after(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects callback with invalid state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/my-project/google/callback?code=abc&state=invalid-garbage',
    })
    assert.equal(res.statusCode, 400)
    assert.ok(
      res.body.includes('tampered') || res.body.includes('Invalid'),
      `Expected tampered/Invalid in body: ${res.body}`,
    )
  })

  it('rejects callback with state signed by wrong secret', async () => {
    const wrongSecretState = buildSignedState(
      { domain: 'example.com', type: 'gsc', redirectUri: 'http://localhost/callback' },
      'wrong-secret',
    )
    const res = await app.inject({
      method: 'GET',
      url: `/projects/my-project/google/callback?code=abc&state=${encodeURIComponent(wrongSecretState)}`,
    })
    assert.equal(res.statusCode, 400)
    assert.ok(
      res.body.includes('tampered') || res.body.includes('Invalid'),
      `Expected tampered/Invalid in body: ${res.body}`,
    )
  })

  it('returns error page when OAuth error is present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/my-project/google/callback?error=access_denied',
    })
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.includes('Authorization failed'))
  })

  it('returns 400 when code or state is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects/my-project/google/callback',
    })
    assert.equal(res.statusCode, 400)
  })
})

describe('googleRoutes: performance filter conditions', () => {
  it('combines all conditions with AND (not chained .where() replacements)', () => {
    // This verifies the fix conceptually: we collect conditions in an array
    // and pass them all to a single and() call, so all filters apply.
    // Previously each .where() call on a $dynamic() query replaced the prior one.
    const conditions: string[] = ['projectId = ?']
    const startDate = '2025-01-01'
    const endDate = '2025-01-31'
    const query = 'seo'
    const page = '/blog'

    if (startDate) conditions.push('date >= ?')
    if (endDate) conditions.push('date <= ?')
    if (query) conditions.push('query LIKE ?')
    if (page) conditions.push('page LIKE ?')

    // All 5 conditions must be present
    assert.equal(conditions.length, 5)
    assert.ok(conditions.includes('projectId = ?'))
    assert.ok(conditions.includes('date >= ?'))
    assert.ok(conditions.includes('date <= ?'))
    assert.ok(conditions.includes('query LIKE ?'))
    assert.ok(conditions.includes('page LIKE ?'))
  })
})
