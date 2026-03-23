import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, test } from 'vitest'
import { createClient, migrate, apiKeys, notifications } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-security-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: false, ...opts })

  return { app, db, tmpDir }
}

function insertApiKey(db: ReturnType<typeof createClient>, rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 9),
    scopes: '["*"]',
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
    expect(JSON.parse(stored!.config) as { url: string }).toEqual({
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
