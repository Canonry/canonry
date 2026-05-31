import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, migrate, cloudMetadata, notifications, parseJsonColumn } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { apiRoutes } from '../src/index.js'

/**
 * Helper to spin up a fresh API + DB for each test. The cloud bootstrap
 * endpoints behave very differently depending on `CANONRY_ENABLE_CLOUD_BOOTSTRAP`,
 * so each test runs against its own DB and env state.
 */
function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-bootstrap-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, canonryVersion: '1.2.3', allowLoopbackWebhooks: true })
  return { app, db, tmpDir, dbPath }
}

const VALID_REQUEST = {
  tenant_id: 'tenant-abc',
  account_id: 'acct-123',
  plan: 'starter',
  // Loopback URL — the test enables `allowLoopbackWebhooks` so the SSRF
  // guard doesn't reject it. Real deployments use a Docker-network URL.
  control_plane_callback_url: 'http://127.0.0.1:18081/cloud/events',
  webhook_secret: 'whsec_deadbeef_deadbeef_deadbeef_dead',
  default_locale: { country: 'US', language: 'en' },
  managed_oauth: {
    google_client_id: 'gci-123.apps.googleusercontent.com',
    google_client_secret: 'gcs-secret-456',
    google_callback_url: 'https://app.canonry.ai/oauth/callback/google',
  },
}

let app: FastifyInstance
let db: ReturnType<typeof createClient>
let tmpDir: string

describe('POST /api/v1/cloud/bootstrap', () => {
  beforeEach(async () => {
    process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP = '1'
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterEach(async () => {
    delete process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes cloud_metadata + notification subscriber on first call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bootstrap',
      headers: { 'X-Admin-Scope': '1' },
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toMatchObject({
      canonry_version: '1.2.3',
      webhook_attached: true,
    })
    expect(typeof body.bootstrap_completed_at).toBe('string')

    const row = db.select().from(cloudMetadata).where(eq(cloudMetadata.id, 'singleton')).get()
    expect(row).toBeDefined()
    expect(row?.tenantId).toBe('tenant-abc')
    expect(row?.accountId).toBe('acct-123')
    expect(row?.plan).toBe('starter')
    expect(row?.controlPlaneCallbackUrl).toBe(VALID_REQUEST.control_plane_callback_url)
    expect(row?.managedGoogleClientId).toBe(VALID_REQUEST.managed_oauth.google_client_id)
    expect(row?.managedGoogleRedirectUrl).toBe(VALID_REQUEST.managed_oauth.google_callback_url)

    const subs = db.select().from(notifications).all()
    expect(subs).toHaveLength(1)
    const config = parseJsonColumn<{ url: string; events: string[]; source?: string }>(
      typeof subs[0]!.config === 'string' ? subs[0]!.config : JSON.stringify(subs[0]!.config),
      {},
    )
    expect(subs[0]!.projectId).toBeNull()
    expect(config.url).toBe(VALID_REQUEST.control_plane_callback_url)
    // Subscribed to all 12 events (six legacy + six cloud).
    expect(config.events).toHaveLength(12)
    expect(config.events).toContain('baseline.completed')
    expect(config.events).toContain('connection.created')
    expect(config.events).toContain('run.completed')
  })

  it('is idempotent — re-running with the same tenant_id refreshes the row', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bootstrap',
      headers: { 'X-Admin-Scope': '1' },
      payload: VALID_REQUEST,
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bootstrap',
      headers: { 'X-Admin-Scope': '1' },
      payload: { ...VALID_REQUEST, plan: 'growth' },
    })
    expect(second.statusCode).toBe(200)

    // Still one row, with updated plan.
    const allMetadata = db.select().from(cloudMetadata).all()
    expect(allMetadata).toHaveLength(1)
    expect(allMetadata[0]!.plan).toBe('growth')

    // Still one notification row — the second bootstrap refreshed it, not duplicated.
    const subs = db.select().from(notifications).all()
    expect(subs).toHaveLength(1)
  })

  it('rejects request without X-Admin-Scope header with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bootstrap',
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('rejects request with wrong X-Admin-Scope value with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bootstrap',
      headers: { 'X-Admin-Scope': 'true' },
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects malformed body with 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bootstrap',
      headers: { 'X-Admin-Scope': '1' },
      payload: { tenant_id: 'tenant-x' }, // missing required fields
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects invalid control_plane_callback_url with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bootstrap',
      headers: { 'X-Admin-Scope': '1' },
      payload: { ...VALID_REQUEST, control_plane_callback_url: 'not-a-url' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('CANONRY_ENABLE_CLOUD_BOOTSTRAP value parsing', () => {
  // Mirror packages/config/src/index.ts:parseBooleanFlag — the route gate
  // must accept the same truthy set so an operator who sets
  // CANONRY_ENABLE_CLOUD_BOOTSTRAP=true (rather than =1) doesn't see
  // config flag the deployment as cloud-enabled while the route still 404s.
  afterEach(async () => {
    delete process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP
    if (app) await app.close()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    it(`accepts CANONRY_ENABLE_CLOUD_BOOTSTRAP=${value}`, async () => {
      process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP = value
      const ctx = buildApp()
      app = ctx.app
      db = ctx.db
      tmpDir = ctx.tmpDir
      await app.ready()

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cloud/bootstrap',
        headers: { 'X-Admin-Scope': '1' },
        payload: VALID_REQUEST,
      })
      // 200 = route was reached + the bootstrap completed. 404 here would
      // signal the env value parse fell through.
      expect(res.statusCode, `expected ${value} to enable the route`).toBe(200)
    })
  }

  for (const value of ['0', 'false', '', 'no']) {
    it(`rejects CANONRY_ENABLE_CLOUD_BOOTSTRAP=${JSON.stringify(value)}`, async () => {
      if (value === '') {
        delete process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP
      } else {
        process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP = value
      }
      const ctx = buildApp()
      app = ctx.app
      db = ctx.db
      tmpDir = ctx.tmpDir
      await app.ready()

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/cloud/bootstrap',
        headers: { 'X-Admin-Scope': '1' },
        payload: VALID_REQUEST,
      })
      expect(res.statusCode).toBe(404)
    })
  }
})

describe('cloud-bridge endpoints with CANONRY_ENABLE_CLOUD_BOOTSTRAP unset', () => {
  beforeEach(async () => {
    delete process.env.CANONRY_ENABLE_CLOUD_BOOTSTRAP
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 404 from /cloud/bootstrap when the flag is unset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cloud/bootstrap',
      headers: { 'X-Admin-Scope': '1' },
      payload: VALID_REQUEST,
    })
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
