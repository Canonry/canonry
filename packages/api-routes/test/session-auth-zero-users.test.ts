/**
 * T1 — an install with ZERO user accounts must behave exactly as it did before
 * named accounts existed.
 *
 * The table below was RECORDED against the base commit (before any of this
 * feature's code was written) and is frozen here on purpose: it is the
 * regression guard for the headline invariant. If a future change to the auth
 * layer moves any of these outcomes, this test fails and says which request
 * changed — it never quietly re-records.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { apiKeys, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const ROOT_KEY = 'cnry_zero_users_root'
const READ_KEY = 'cnry_zero_users_read'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

function seedKey(name: string, token: string, scopes: string[]) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    createdAt: new Date().toISOString(),
  }).run()
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-zero-users-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedKey('root', ROOT_KEY, ['*'])
  seedKey('reader', READ_KEY, ['read'])
  db.insert(projects).values({
    id: crypto.randomUUID(),
    name: 'sample',
    displayName: 'Sample',
    canonicalDomain: 'sample.example',
    country: 'US',
    language: 'en',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run()

  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Recorded outcomes. `key: null` means no Authorization header at all. */
const RECORDED: Array<{
  label: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  key: string | null
  status: number
  code?: string
}> = [
  { label: 'project list, no credential', method: 'GET', url: '/api/v1/projects', key: null, status: 401, code: 'AUTH_REQUIRED' },
  { label: 'project list, root key', method: 'GET', url: '/api/v1/projects', key: ROOT_KEY, status: 200 },
  { label: 'project list, read-only key', method: 'GET', url: '/api/v1/projects', key: READ_KEY, status: 200 },
  { label: 'project read, root key', method: 'GET', url: '/api/v1/projects/sample', key: ROOT_KEY, status: 200 },
  { label: 'openapi document is public', method: 'GET', url: '/api/v1/openapi.json', key: null, status: 200 },
  { label: 'run trigger, no credential', method: 'POST', url: '/api/v1/projects/sample/runs', key: null, status: 401, code: 'AUTH_REQUIRED' },
  { label: 'run trigger, read-only key', method: 'POST', url: '/api/v1/projects/sample/runs', key: READ_KEY, status: 403, code: 'FORBIDDEN' },
  { label: 'settings read, no credential', method: 'GET', url: '/api/v1/settings', key: null, status: 401, code: 'AUTH_REQUIRED' },
  { label: 'settings read, read-only key', method: 'GET', url: '/api/v1/settings', key: READ_KEY, status: 200 },
  { label: 'settings write, read-only key', method: 'PUT', url: '/api/v1/settings/providers/openai', key: READ_KEY, status: 403, code: 'FORBIDDEN' },
  { label: 'key list, read-only key', method: 'GET', url: '/api/v1/keys', key: READ_KEY, status: 200 },
  { label: 'key mint, read-only key', method: 'POST', url: '/api/v1/keys', key: READ_KEY, status: 403, code: 'FORBIDDEN' },
  { label: 'compile preview, read-only key', method: 'POST', url: '/api/v1/projects/sample/measurement-plan/compile-preview', key: READ_KEY, status: 403, code: 'FORBIDDEN' },
  { label: 'measurement plan read, read-only key', method: 'GET', url: '/api/v1/projects/sample/measurement-plan', key: READ_KEY, status: 200 },
  { label: 'garbage bearer token', method: 'GET', url: '/api/v1/projects', key: 'cnry_not_a_real_key', status: 401, code: 'AUTH_INVALID' },
]

test('zero-users mode reproduces the recorded request outcomes exactly', async () => {
  const actual: Array<{ label: string; status: number; code?: string }> = []
  for (const row of RECORDED) {
    const res = await app.inject({
      method: row.method,
      url: row.url,
      ...(row.key ? { headers: { authorization: `Bearer ${row.key}` } } : {}),
      payload: {},
    })
    const code = (() => {
      try {
        return (JSON.parse(res.body) as { error?: { code?: string } }).error?.code
      } catch {
        return undefined
      }
    })()
    actual.push({ label: row.label, status: res.statusCode, ...(row.code ? { code } : {}) })
  }

  expect(actual).toEqual(
    RECORDED.map(row => ({ label: row.label, status: row.status, ...(row.code ? { code: row.code } : {}) })),
  )
})

test('zero-users mode reports that no sign-in is required', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/auth/session' })

  expect(res.statusCode).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ authRequired: false, user: null })
})

test('zero-users mode leaves the login route inert', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'http://localhost:4100', host: 'localhost:4100' },
    payload: { name: 'anybody', password: 'anything-at-all' },
  })

  // No accounts exist, so there is nobody to sign in as. The answer must not
  // leak whether the name or the password was the problem.
  expect(res.statusCode).toBe(401)
  expect(JSON.parse(res.body).error.message).toBe('Incorrect name or password.')
})
