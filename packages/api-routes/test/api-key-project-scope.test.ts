import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, apiKeys, projects, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

/**
 * Project-scoped API keys (#embed-v2 M0). A key with `project_id` set may only
 * touch THAT project — enforced centrally for `/projects/<name>` routes (the
 * auth-plugin URL gate) and per-entity for id-addressed routes (`/runs/:id` via
 * `assertProjectScope`). `GET /projects` is filtered so a scoped key never sees
 * a sibling. A NULL `project_id` key keeps full-instance access (the historical
 * default) byte-for-byte.
 */
let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

const NOW = new Date().toISOString()
const ROOT_KEY = 'cnry_roottoken' // wildcard, full instance
const SCOPED_KEY = 'cnry_scopedtoken' // read-only, scoped to project A
let projectAId: string
let runAId: string
let runBId: string

function seedKey(name: string, raw: string, scopes: string[], projectId?: string): void {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name, keyHash: hashApiKey(raw), keyPrefix: raw.slice(0, 9),
    scopes, projectId: projectId ?? null, createdAt: NOW,
  }).run()
}

function seedProject(name: string): string {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id, name, displayName: name, canonicalDomain: `${name}.example`,
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  return id
}

function seedRun(projectId: string): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: NOW, finishedAt: NOW,
  }).run()
  return id
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-scope-test-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  projectAId = seedProject('project-a')
  seedProject('project-b')
  runAId = seedRun(projectAId)
  runBId = seedRun(db.select({ id: projects.id }).from(projects).all().find(p => p.id !== projectAId)!.id)
  seedKey('root', ROOT_KEY, ['*'])
  seedKey('scoped', SCOPED_KEY, ['read', 'embed'], projectAId)

  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function authed(method: 'GET' | 'POST', url: string, token: string, body?: unknown) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { payload: body } : {}) })
}

describe('project-scoped API keys', () => {
  it('a scoped key reads its OWN project (200)', async () => {
    expect((await authed('GET', '/api/v1/projects/project-a', SCOPED_KEY)).statusCode).toBe(200)
  })

  it('a scoped key is FORBIDDEN on a sibling project (403, central URL gate)', async () => {
    const res = await authed('GET', '/api/v1/projects/project-b', SCOPED_KEY)
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('GET /projects returns ONLY the scoped project for a scoped key', async () => {
    const res = await authed('GET', '/api/v1/projects', SCOPED_KEY)
    expect(res.statusCode).toBe(200)
    expect((res.json() as Array<{ name: string }>).map(p => p.name)).toEqual(['project-a'])
  })

  it('GET /projects returns ALL projects for a full-instance key (unchanged)', async () => {
    const res = await authed('GET', '/api/v1/projects', ROOT_KEY)
    expect((res.json() as Array<{ name: string }>).map(p => p.name).sort()).toEqual(['project-a', 'project-b'])
  })

  it('a scoped key is FORBIDDEN on a sibling run via /runs/:id (entity gate)', async () => {
    expect((await authed('GET', `/api/v1/runs/${runBId}`, SCOPED_KEY)).statusCode).toBe(403)
  })

  it('a scoped key CAN read its own run via /runs/:id', async () => {
    expect((await authed('GET', `/api/v1/runs/${runAId}`, SCOPED_KEY)).statusCode).toBe(200)
  })

  it('a full-instance key reads any project + any run (unchanged)', async () => {
    expect((await authed('GET', '/api/v1/projects/project-b', ROOT_KEY)).statusCode).toBe(200)
    expect((await authed('GET', `/api/v1/runs/${runBId}`, ROOT_KEY)).statusCode).toBe(200)
  })

  it('the project gate does NOT over-restrict non-project routes (GET /keys works for a scoped key)', async () => {
    expect((await authed('GET', '/api/v1/keys', SCOPED_KEY)).statusCode).toBe(200)
  })

  it('POST /keys with a valid projectId mints a scoped key', async () => {
    const res = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: 'embed-a', scopes: ['read', 'embed'], projectId: projectAId })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { projectId: string }).projectId).toBe(projectAId)
  })

  it('POST /keys with an unknown projectId is rejected (404)', async () => {
    const res = await authed('POST', '/api/v1/keys', ROOT_KEY, { name: 'bad', projectId: 'does-not-exist' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /keys/self surfaces the scoped projectId', async () => {
    const res = await authed('GET', '/api/v1/keys/self', SCOPED_KEY)
    expect((res.json() as { projectId: string | null }).projectId).toBe(projectAId)
  })
})
