import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, test } from 'vitest'
import { apiKeys, createClient, migrate, notifications, projects, users } from '@ainyc/canonry-db'
import { apiRoutes, hashApiKey, hashUserPassword } from '../src/index.js'
import { USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'
const WILDCARD_KEY = 'cnry_export_wildcard'
const READ_ONLY_KEY = 'cnry_export_read_only'
const NAMED_SCOPE_KEY = 'cnry_export_named_scope'
const SCOPED_WILDCARD_KEY = 'cnry_export_scoped_wildcard'

function seedKey(
  db: ReturnType<typeof createClient>,
  token: string,
  scopes: string[],
  projectId?: string,
): void {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: token,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    projectId: projectId ?? null,
    createdAt: new Date().toISOString(),
  }).run()
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

async function session(app: ReturnType<typeof Fastify>, name: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { name, password },
  })
  expect(response.statusCode).toBe(200)
  const raw = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'][0]!
    : String(response.headers['set-cookie'])
  return decodeURIComponent(raw.split(';')[0]!.split('=')[1]!)
}

test('includeSecrets requires wildcard authority and an administrator session', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-export-secret-auth-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'secret-export',
    displayName: 'Secret export',
    canonicalDomain: 'secret-export.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(notifications).values({
    id: 'secret-export-notification',
    projectId,
    channel: 'webhook',
    config: { url: 'https://hooks.example.com/secret/export', events: ['run.completed'] },
    webhookSecret: 'secret-export-signing-key',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }).run()
  seedKey(db, WILDCARD_KEY, ['*'])
  seedKey(db, READ_ONLY_KEY, ['read'])
  seedKey(db, NAMED_SCOPE_KEY, ['ads.write'])
  seedKey(db, SCOPED_WILDCARD_KEY, ['*'], projectId)
  db.insert(users).values([
    { id: 'export-admin', name: 'Export Admin', nameKey: 'export admin', passwordHash: await hashUserPassword('export-admin-password'), role: 'admin', createdAt: now },
    { id: 'export-viewer', name: 'Export Viewer', nameKey: 'export viewer', passwordHash: await hashUserPassword('export-viewer-password'), role: 'viewer', createdAt: now },
  ]).run()

  const app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()

  try {
    const wildcard = await app.inject({ method: 'GET', url: '/api/v1/projects/secret-export/export?includeSecrets=true', headers: auth(WILDCARD_KEY) })
    expect(wildcard.statusCode).toBe(200)
    expect(wildcard.json().spec.notifications[0].url).toBe('https://hooks.example.com/secret/export')

    const scopedOwn = await app.inject({ method: 'GET', url: '/api/v1/projects/secret-export/export?includeSecrets=true', headers: auth(SCOPED_WILDCARD_KEY) })
    expect(scopedOwn.statusCode).toBe(200)
    expect(scopedOwn.json().spec.notifications[0].url).toBe('https://hooks.example.com/secret/export')

    const scopedOther = await app.inject({ method: 'GET', url: '/api/v1/projects/other-project/export?includeSecrets=true', headers: auth(SCOPED_WILDCARD_KEY) })
    expect(scopedOther.statusCode).toBe(403)

    for (const token of [READ_ONLY_KEY, NAMED_SCOPE_KEY]) {
      const denied = await app.inject({ method: 'GET', url: '/api/v1/projects/secret-export/export?includeSecrets=true', headers: auth(token) })
      expect(denied.statusCode).toBe(403)
      expect(denied.json().error.code).toBe('FORBIDDEN')
    }

    const adminSession = await session(app, 'Export Admin', 'export-admin-password')
    const admin = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/secret-export/export?includeSecrets=true',
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${adminSession}`, origin: ORIGIN, host: HOST },
    })
    expect(admin.statusCode).toBe(200)
    expect(admin.json().spec.notifications[0].url).toBe('https://hooks.example.com/secret/export')

    const viewerSession = await session(app, 'Export Viewer', 'export-viewer-password')
    const viewer = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/secret-export/export?includeSecrets=true',
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${viewerSession}`, origin: ORIGIN, host: HOST },
    })
    expect(viewer.statusCode).toBe(403)
    expect(viewer.json().error.code).toBe('FORBIDDEN')

    const normalExport = await app.inject({ method: 'GET', url: '/api/v1/projects/secret-export/export', headers: auth(READ_ONLY_KEY) })
    expect(normalExport.statusCode).toBe(200)
    expect(normalExport.body).not.toContain('/secret/export')
    expect(normalExport.json().spec.notifications[0].url).toBe('redacted://hooks.example.com/secret-export-notification')
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
