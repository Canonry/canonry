import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiKeys, auditLog, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { buildOpenApiDocument } from '../src/openapi.js'
import { USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

const ROOT_KEY = 'cnry_create_root'
const PROJECT_WRITER_KEY = 'cnry_create_projects'
const READ_KEY = 'cnry_create_read'
const USERS_WRITER_KEY = 'cnry_create_users'
const SCOPED_WRITER_KEY = 'cnry_create_scoped'
const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let callbackCalls: Array<{ id: string; name: string }>
let createdCallbackCalls: Array<{ id: string; name: string }>
let createdCallbackError: Error | undefined
let existingProjectId: string

function seedKey(name: string, token: string, scopes: string[], projectId?: string): void {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    projectId: projectId ?? null,
    createdAt: new Date().toISOString(),
  }).run()
}

function headersForKey(token: string) {
  return { authorization: `Bearer ${token}` }
}

function createPayload(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    displayName: 'Acme & Co.',
    canonicalDomain: 'https://www.Acme.Example/path?source=onboarding',
    country: 'US',
    language: 'en',
    ...overrides,
  }
}

async function createProject(token: string, name: string, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: headersForKey(token),
    payload: createPayload(name, overrides),
  })
}

async function createAccount(name: string, password: string, role: 'admin' | 'viewer') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: headersForKey(ROOT_KEY),
    payload: { name, password, role },
  })
}

async function signIn(name: string, password: string): Promise<string> {
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-project-create-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const now = new Date().toISOString()
  existingProjectId = crypto.randomUUID()
  db.insert(projects).values({
    id: existingProjectId,
    name: 'existing',
    displayName: 'Existing',
    canonicalDomain: 'existing.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  seedKey('root', ROOT_KEY, ['*'])
  seedKey('project-writer', PROJECT_WRITER_KEY, ['projects.write'])
  seedKey('reader', READ_KEY, ['read'])
  seedKey('account-writer', USERS_WRITER_KEY, ['users.write'])
  seedKey('scoped-project-writer', SCOPED_WRITER_KEY, ['*'], existingProjectId)

  callbackCalls = []
  createdCallbackCalls = []
  createdCallbackError = undefined
  app = Fastify()
  app.register(apiRoutes, {
    db,
    onProjectUpserted: (id, name) => callbackCalls.push({ id, name }),
    onProjectCreated: (id, name) => {
      if (createdCallbackError) throw createdCallbackError
      createdCallbackCalls.push({ id, name })
    },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('POST /projects', () => {
  it('documents the create-only operation with typed request and response schemas', () => {
    const operation = buildOpenApiDocument().paths?.['/api/v1/projects']?.post
    expect(operation?.requestBody?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/ProjectCreateRequest',
    })
    expect(operation?.responses?.['201']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/ProjectDto',
    })
    expect(operation?.responses?.['409']).toBeDefined()
  })

  it('creates once with normalized name and canonical domain, then audits and notifies once', async () => {
    const response = await createProject(ROOT_KEY, '  Acmé & Co.  ')

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      name: 'acme-co',
      displayName: 'Acme & Co.',
      canonicalDomain: 'acme.example',
    })

    const created = db.select().from(projects).where(eq(projects.name, 'acme-co')).get()!
    expect(callbackCalls).toEqual([{ id: created.id, name: 'acme-co' }])
    expect(createdCallbackCalls).toEqual([{ id: created.id, name: 'acme-co' }])
    const createdAudit = db.select().from(auditLog).where(and(
      eq(auditLog.projectId, created.id),
      eq(auditLog.action, 'project.created'),
    )).all()
    expect(createdAudit).toHaveLength(1)
  })

  it('keeps the committed create successful when its post-commit callback fails', async () => {
    createdCallbackError = new Error('schedule seed failed')

    const response = await createProject(ROOT_KEY, 'callback-failure')

    expect(response.statusCode).toBe(201)
    expect(db.select().from(projects).where(eq(projects.name, 'callback-failure')).get()).toBeTruthy()
  })

  it('returns a typed 409 for a normalized-name collision without mutating the existing project', async () => {
    expect((await createProject(ROOT_KEY, 'Acme Co')).statusCode).toBe(201)
    const conflict = await createProject(ROOT_KEY, ' acme---co ')

    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toMatchObject({ error: { code: 'ALREADY_EXISTS' } })
    expect(db.select().from(projects).where(eq(projects.name, 'acme-co')).get()).toMatchObject({
      displayName: 'Acme & Co.',
      canonicalDomain: 'acme.example',
      configRevision: 1,
    })
    expect(callbackCalls).toHaveLength(1)
    expect(db.select().from(auditLog).where(eq(auditLog.action, 'project.created')).all()).toHaveLength(1)
  })

  it('allows distinct projects to share a canonical domain', async () => {
    expect((await createProject(ROOT_KEY, 'First Site')).statusCode).toBe(201)
    const second = await createProject(ROOT_KEY, 'Same Site, Different Name', {
      canonicalDomain: 'http://acme.example/another-path',
    })

    expect(second.statusCode).toBe(201)
    expect(second.json()).toMatchObject({
      name: 'same-site-different-name',
      canonicalDomain: 'acme.example',
    })
    expect(db.select().from(projects).where(eq(projects.canonicalDomain, 'acme.example')).all()).toHaveLength(2)
    expect(callbackCalls).toHaveLength(2)
    expect(db.select().from(auditLog).where(eq(auditLog.action, 'project.created')).all()).toHaveLength(2)
  })

  it('rejects an unparseable canonical domain before writing any project', async () => {
    const response = await createProject(ROOT_KEY, 'Bad Host', { canonicalDomain: 'not a hostname' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(db.select().from(projects).where(eq(projects.name, 'bad-host')).get()).toBeUndefined()
  })

  it('allows only an unscoped projects.write/root key and refuses read-only, unrelated, and project-scoped keys', async () => {
    expect((await createProject(PROJECT_WRITER_KEY, 'Project Writer')).statusCode).toBe(201)
    expect((await createProject(ROOT_KEY, 'Root Writer', { canonicalDomain: 'root.example' })).statusCode).toBe(201)

    for (const [token, name] of [
      [READ_KEY, 'Read Only'],
      [USERS_WRITER_KEY, 'Unrelated Writer'],
      [SCOPED_WRITER_KEY, 'Scoped Writer'],
    ] as const) {
      const response = await createProject(token, name)
      expect(response.statusCode, name).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    }
  })

  it('allows an administrator session and refuses a viewer session', async () => {
    const adminPassword = 'an-admin-password-long-enough'
    const viewerPassword = 'a-viewer-password-long-enough'
    expect((await createAccount('owner', adminPassword, 'admin')).statusCode).toBe(201)
    expect((await createAccount('viewer', viewerPassword, 'viewer')).statusCode).toBe(201)

    const adminSession = await signIn('owner', adminPassword)
    const adminResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${adminSession}`, origin: ORIGIN, host: HOST },
      payload: createPayload('Administrator Project'),
    })
    expect(adminResponse.statusCode).toBe(201)

    const viewerSession = await signIn('viewer', viewerPassword)
    const viewerResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${viewerSession}`, origin: ORIGIN, host: HOST },
      payload: createPayload('Viewer Project'),
    })
    expect(viewerResponse.statusCode).toBe(403)
    expect(viewerResponse.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  })
})
