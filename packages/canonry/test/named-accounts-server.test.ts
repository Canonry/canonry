/**
 * The shared dashboard password and named accounts cannot both be a way in.
 *
 * The shared password mints a session bound to the install's root key — full
 * access to everything. Left live alongside named accounts, one shared secret
 * would hand every holder the authority the roles were created to separate.
 * So the moment the first account exists, those routes step aside and say why.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, describe } from 'vitest'
import { apiKeys, createClient, migrate, users, type DatabaseClient } from '@ainyc/canonry-db'
import { hashUserPassword } from '@ainyc/canonry-api-routes'
import { createServer } from '../src/server.js'

let tmpDir: string
let db: DatabaseClient
let app: Awaited<ReturnType<typeof createServer>>
let rawKey: string

async function bootServer() {
  return createServer({
    config: {
      apiUrl: 'http://localhost:4100',
      database: path.join(tmpDir, 'test.db'),
      apiKey: rawKey,
      geminiApiKey: 'test-key',
    },
    db,
    logger: false,
  })
}

async function addAccount(name: string, role: 'admin' | 'viewer') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: { authorization: `Bearer ${rawKey}` },
    payload: { name, role, password: 'a-long-enough-admin-password' },
  })
  expect(response.statusCode).toBe(201)
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-named-accounts-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'root',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()
  app = await bootServer()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('shared dashboard password alongside named accounts', () => {
  it('still works exactly as before while there are no accounts', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/session' })
    expect(JSON.parse(before.body)).toEqual({ authenticated: false, setupRequired: true })

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'a-perfectly-fine-shared-password' },
    })
    expect(setup.statusCode).toBe(200)
    expect(JSON.parse(setup.body)).toEqual({ authenticated: true })
  })

  it('steps aside once the first account exists, and says what to do instead', async () => {
    await addAccount('owner', 'admin')

    const status = await app.inject({ method: 'GET', url: '/api/v1/session' })
    expect(JSON.parse(status.body)).toEqual({ authenticated: false, setupRequired: false })

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/session/setup',
      payload: { password: 'a-perfectly-fine-shared-password' },
    })
    expect(setup.statusCode).toBe(403)
    expect(JSON.parse(setup.body).error.message).toBe(
      'This install uses named accounts. Sign in with your name and password.',
    )

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { password: 'a-perfectly-fine-shared-password' },
    })
    expect(login.statusCode).toBe(403)
  })

  it('reports the new sign-in state on the account-aware route', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/auth/session' })
    expect(JSON.parse(before.body)).toEqual({ authRequired: false, user: null })

    await addAccount('owner', 'admin')

    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/session' })
    expect(JSON.parse(after.body)).toEqual({ authRequired: true, user: null })
  })

  it('leaves the API key working throughout', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(before.statusCode).toBe(200)

    await addAccount('owner', 'admin')

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${rawKey}` },
    })
    expect(after.statusCode).toBe(200)
  })
})

describe('the sign-in cookie on a real server', () => {
  it('is marked Secure when a proxy in front of it terminated TLS', async () => {
    // The config flag sees no https public URL on this fixture, which is
    // exactly the deployment shape that must NOT end up with an insecure
    // cookie: a plain-http bind behind a TLS-terminating proxy.
    db.insert(users).values({
      id: crypto.randomUUID(),
      name: 'owner',
      nameKey: 'owner',
      passwordHash: await hashUserPassword('a-long-enough-admin-password'),
      role: 'admin',
      createdAt: new Date().toISOString(),
    }).run()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-proto': 'https', origin: 'http://localhost:4100', host: 'localhost:4100' },
      payload: { name: 'owner', password: 'a-long-enough-admin-password' },
    })

    expect(res.statusCode).toBe(200)
    expect(String(res.headers['set-cookie'])).toContain('Secure')
  })
})
