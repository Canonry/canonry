import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, test } from 'vitest'
import { ADS_WRITE_SCOPE } from '@ainyc/canonry-contracts'
import { createClient, migrate, apiKeys, notifications, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-security-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  // Google routes register only when a state secret is configured; the
  // public-route exception test below covers /google/callback, so seed a
  // dummy secret to keep that surface mounted under test.
  app.register(apiRoutes, { db, skipAuth: false, googleStateSecret: 'test-only-google-state-secret-32b', ...opts })

  return { app, db, tmpDir }
}

function insertApiKey(db: ReturnType<typeof createClient>, rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  return rawKey
}

test('auth protects non-public routes while keeping public exceptions reachable', async () => {
  const { app, tmpDir } = buildApp({
    getGoogleAuthConfig: () => ({ clientId: 'google-client-id', clientSecret: 'google-client-secret' }),
    googleConnectionStore: {
      listConnections: () => [],
      getConnection: () => undefined,
      upsertConnection: (connection) => connection,
      updateConnection: () => undefined,
      deleteConnection: () => false,
    },
  })
  await app.ready()

  try {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/projects' })
    expect(listRes.statusCode).toBe(401)
    expect(JSON.parse(listRes.body).error.code).toBe('AUTH_REQUIRED')

    const runRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/probe/runs',
      payload: {},
    })
    expect(runRes.statusCode).toBe(401)

    const openApiRes = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(openApiRes.statusCode).toBe(200)

    const callbackRes = await app.inject({ method: 'GET', url: '/api/v1/google/callback' })
    expect(callbackRes.statusCode).toBe(400)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('bearer auth reaches protected routes and updates key usage', async () => {
  const { app, db, tmpDir } = buildApp()
  const rawKey = insertApiKey(db)
  await app.ready()

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${rawKey}` },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
    expect(db.select().from(apiKeys).all()[0]?.lastUsedAt).toBeTruthy()
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('settings routes refuse keys that lack the settings.write scope', async () => {
  // Provider key updates can replace the operator's OpenAI / Anthropic /
  // Google / Bing credentials. Without scope gating, any bearer holder
  // could swap them. The gate accepts wildcard `'*'` (the default `canonry
  // init` key) and a future `settings.write` scope. A read-only key (any
  // scope set that doesn't include either) is forbidden.
  const { app, db, tmpDir } = buildApp({
    googleSettingsSummary: { configured: false },
    onGoogleSettingsUpdate: () => ({ configured: true }),
  })

  // Read-only key — explicit, narrow scope list.
  const readOnlyRaw = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'read-only',
    keyHash: crypto.createHash('sha256').update(readOnlyRaw).digest('hex'),
    keyPrefix: readOnlyRaw.slice(0, 9),
    scopes: ['read'],
    createdAt: new Date().toISOString(),
  }).run()

  // Admin key — wildcard. Mirrors what `canonry init` writes for the
  // install's primary key.
  const adminRaw = insertApiKey(db)

  await app.ready()
  try {
    // Read-only key is forbidden.
    const forbidden = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/google',
      headers: { authorization: `Bearer ${readOnlyRaw}` },
      payload: { clientId: 'g', clientSecret: 's' },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(JSON.parse(forbidden.body).error.code).toBe('FORBIDDEN')

    // Wildcard key works.
    const allowed = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/google',
      headers: { authorization: `Bearer ${adminRaw}` },
      payload: { clientId: 'g', clientSecret: 's' },
    })
    expect(allowed.statusCode).toBe(200)

    // A key that explicitly carries 'settings.write' (no wildcard) works.
    const scopedRaw = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'settings-only',
      keyHash: crypto.createHash('sha256').update(scopedRaw).digest('hex'),
      keyPrefix: scopedRaw.slice(0, 9),
      scopes: ['settings.write'],
      createdAt: new Date().toISOString(),
    }).run()
    const scoped = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/google',
      headers: { authorization: `Bearer ${scopedRaw}` },
      payload: { clientId: 'g', clientSecret: 's' },
    })
    expect(scoped.statusCode).toBe(200)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a read-only key is blocked on every write method but passes reads', async () => {
  // The global read-only gate lives in the auth plugin and keys off the HTTP
  // method — NOT on per-route `requireScope` calls. Prove it by hitting a write
  // route that has no `requireScope` of its own (`POST .../runs`, `PUT
  // /projects/:name`): a `['read']` key must still be forbidden there.
  const { app, db, tmpDir } = buildApp()

  const readOnlyRaw = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'reader',
    keyHash: crypto.createHash('sha256').update(readOnlyRaw).digest('hex'),
    keyPrefix: readOnlyRaw.slice(0, 9),
    scopes: ['read'],
    createdAt: new Date().toISOString(),
  }).run()

  const wildcardRaw = insertApiKey(db)
  await app.ready()

  try {
    const readHeaders = { authorization: `Bearer ${readOnlyRaw}` }

    // Reads pass.
    const list = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: readHeaders })
    expect(list.statusCode).toBe(200)

    // A wildcard key seeds a project so the write routes below resolve a real
    // target rather than 404-ing before the gate is exercised.
    const seed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/gate-test',
      headers: { authorization: `Bearer ${wildcardRaw}` },
      payload: { displayName: 'Gate Test', canonicalDomain: 'example.com', country: 'US', language: 'en' },
    })
    expect(seed.statusCode).toBe(201)

    // Writes are forbidden — across a route with no requireScope (runs) AND a
    // create/update route (PUT project), AND a DELETE.
    for (const req of [
      { method: 'POST' as const, url: '/api/v1/projects/gate-test/runs', payload: {} },
      { method: 'PUT' as const, url: '/api/v1/projects/gate-test', payload: { displayName: 'x', canonicalDomain: 'example.com', country: 'US', language: 'en' } },
      { method: 'DELETE' as const, url: '/api/v1/projects/gate-test' },
    ]) {
      const res = await app.inject({ ...req, headers: readHeaders })
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN')
    }

    // The wildcard key is unaffected — it can still write (delete the project).
    const wildcardDelete = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/gate-test',
      headers: { authorization: `Bearer ${wildcardRaw}` },
    })
    expect(wildcardDelete.statusCode).toBe(204)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a project-scoped ads.write key cannot mutate non-ads state', async () => {
  const { app, db, tmpDir } = buildApp()
  const rootKey = insertApiKey(db)
  await app.ready()

  try {
    const seed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/ads-delegate-test',
      headers: { authorization: `Bearer ${rootKey}` },
      payload: {
        displayName: 'Ads Delegate Test',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(seed.statusCode).toBe(201)
    const project = db.select().from(projects).all()
      .find((row) => row.name === 'ads-delegate-test')!

    const adsKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'ads-delegate',
      keyHash: crypto.createHash('sha256').update(adsKey).digest('hex'),
      keyPrefix: adsKey.slice(0, 9),
      scopes: ['read', ADS_WRITE_SCOPE],
      projectId: project.id,
      createdAt: new Date().toISOString(),
    }).run()
    const headers = { authorization: `Bearer ${adsKey}` }

    const unrelated = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/ads-delegate-test/runs',
      headers,
      payload: {},
    })
    expect(unrelated.statusCode).toBe(403)
    expect(JSON.parse(unrelated.body).error.message).toContain('only perform OpenAI Ads')

    const adsWrite = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/ads-delegate-test/ads/sync',
      headers,
    })
    expect(adsWrite.statusCode).toBe(400)
    expect(JSON.parse(adsWrite.body).error.code).toBe('VALIDATION_ERROR')
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('notification APIs and history redact webhook secrets while keeping stored delivery config intact', async () => {
  const { app, db, tmpDir } = buildApp()
  const rawKey = insertApiKey(db)
  const authHeaders = { authorization: `Bearer ${rawKey}` }
  const secretUrl = 'https://8.8.8.8/hooks/secret-token?api_key=super-secret'
  await app.ready()

  try {
    const projectRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/secure-project',
      headers: authHeaders,
      payload: {
        displayName: 'Secure Project',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(projectRes.statusCode).toBe(201)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/secure-project/notifications',
      headers: authHeaders,
      payload: {
        channel: 'webhook',
        url: secretUrl,
        events: ['run.completed'],
      },
    })
    expect(createRes.statusCode).toBe(201)

    const created = JSON.parse(createRes.body) as {
      url: string
      urlDisplay: string
      urlHost: string
      webhookSecret?: string
    }
    expect(created.url).toBe('https://8.8.8.8/redacted')
    expect(created.urlDisplay).toBe('8.8.8.8/redacted')
    expect(created.urlHost).toBe('8.8.8.8')
    expect(created.url).not.toContain('secret-token')
    expect(created.urlDisplay).not.toContain('super-secret')
    expect(created.webhookSecret).toBeTruthy()

    const stored = db.select().from(notifications).all()[0]
    expect(stored).toBeDefined()
    expect(stored!.config).toEqual({
      url: secretUrl,
      events: ['run.completed'],
    })

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/secure-project/notifications',
      headers: authHeaders,
    })
    expect(listRes.statusCode).toBe(200)
    expect(listRes.body).not.toContain('secret-token')
    expect(listRes.body).not.toContain('super-secret')

    const historyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/secure-project/history',
      headers: authHeaders,
    })
    expect(historyRes.statusCode).toBe(200)
    expect(historyRes.body).not.toContain('secret-token')
    expect(historyRes.body).not.toContain('super-secret')
    expect(historyRes.body).toContain('8.8.8.8/redacted')
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
