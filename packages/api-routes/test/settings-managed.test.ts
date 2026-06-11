/**
 * `/settings/*` write protection under `CANONRY_MANAGED_SETTINGS=1`
 * (Track 1 — Canonry Hosted).
 *
 * The cloud control plane owns provider API keys, OAuth client credentials,
 * and the Bing API key. In cloud mode the tenant container refuses writes to
 * those routes so a leaked tenant API key can't silently swap the operator's
 * pool keys for an attacker's. Read endpoints stay available so the UI can
 * display the managed values (the hide-in-cloud UI logic is a separate
 * ticket).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { apiKeys, createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-managed-settings-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: false, ...opts })
  return { app, db, tmpDir }
}

function insertApiKey(db: ReturnType<typeof createClient>): string {
  const raw = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'admin',
    keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
    keyPrefix: raw.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()
  return raw
}

describe('CANONRY_MANAGED_SETTINGS=1 blocks /settings/* writes', () => {
  const originalEnv = process.env.CANONRY_MANAGED_SETTINGS

  beforeEach(() => {
    process.env.CANONRY_MANAGED_SETTINGS = '1'
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CANONRY_MANAGED_SETTINGS
    } else {
      process.env.CANONRY_MANAGED_SETTINGS = originalEnv
    }
  })

  test('PUT /settings/google returns 403 with FORBIDDEN', async () => {
    const { app, db, tmpDir } = buildApp({
      googleSettingsSummary: { configured: false },
      onGoogleSettingsUpdate: () => ({ configured: true }),
    })
    const key = insertApiKey(db)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/google',
        headers: { authorization: `Bearer ${key}` },
        payload: { clientId: 'g', clientSecret: 's' },
      })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('PUT /settings/bing returns 403 with FORBIDDEN', async () => {
    const { app, db, tmpDir } = buildApp({
      bingSettingsSummary: { configured: false },
      onBingSettingsUpdate: () => ({ configured: true }),
    })
    const key = insertApiKey(db)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/bing',
        headers: { authorization: `Bearer ${key}` },
        payload: { apiKey: 'whatever' },
      })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('PUT /settings/providers/:name returns 403 with FORBIDDEN', async () => {
    const { app, db, tmpDir } = buildApp({
      providerAdapters: [
        {
          name: 'openai', displayName: 'OpenAI', mode: 'api',
          modelValidationPattern: /./, modelValidationHint: 'any',
        },
      ],
      onProviderUpdate: () => ({ name: 'openai', configured: true }),
    })
    const key = insertApiKey(db)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/providers/openai',
        headers: { authorization: `Bearer ${key}` },
        payload: { apiKey: 'sk-test' },
      })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN')
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('GET /settings still works (reads are not blocked)', async () => {
    // The dashboard needs to read the configured provider list to render
    // the cloud-mode settings tab — the cloud UI shows the managed values
    // but disables the controls.
    const { app, db, tmpDir } = buildApp({
      providerSummary: [{ name: 'openai', configured: true }],
      googleSettingsSummary: { configured: true },
      bingSettingsSummary: { configured: false },
    })
    const key = insertApiKey(db)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/settings',
        headers: { authorization: `Bearer ${key}` },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.providers).toEqual([{ name: 'openai', configured: true }])
      expect(body.google).toEqual({ configured: true })
      expect(body.bing).toEqual({ configured: false })
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('CANONRY_MANAGED_SETTINGS unset (OSS default) allows writes', () => {
  // Regression guard: removing the env flag must NOT trip the 403 — OSS
  // operators still need to configure provider keys via the UI.
  const originalEnv = process.env.CANONRY_MANAGED_SETTINGS

  beforeEach(() => {
    delete process.env.CANONRY_MANAGED_SETTINGS
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CANONRY_MANAGED_SETTINGS
    } else {
      process.env.CANONRY_MANAGED_SETTINGS = originalEnv
    }
  })

  test('PUT /settings/google succeeds with admin scope', async () => {
    const { app, db, tmpDir } = buildApp({
      googleSettingsSummary: { configured: false },
      onGoogleSettingsUpdate: () => ({ configured: true }),
    })
    const key = insertApiKey(db)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/settings/google',
        headers: { authorization: `Bearer ${key}` },
        payload: { clientId: 'g', clientSecret: 's' },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
