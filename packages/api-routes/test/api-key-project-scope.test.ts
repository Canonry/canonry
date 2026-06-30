import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, apiKeys, auditLog, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { CitationStates } from '@ainyc/canonry-contracts'
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
const SCOPED_WRITE_KEY = 'cnry_scopedwrite' // full scopes, scoped to project A (exercises the write paths)
const SCOPED_B_KEY = 'cnry_scopedbtoken' // read-only, scoped to project B
let projectAId: string
let projectBId: string
let runAId: string
let runBId: string
let rootKeyId: string
let scopedKeyId: string
let scopedBKeyId: string

function seedKey(name: string, raw: string, scopes: string[], projectId?: string): string {
  const id = crypto.randomUUID()
  db.insert(apiKeys).values({
    id, name, keyHash: hashApiKey(raw), keyPrefix: raw.slice(0, 9),
    scopes, projectId: projectId ?? null, createdAt: NOW,
  }).run()
  return id
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

function seedQuery(projectId: string, query: string): string {
  const id = crypto.randomUUID()
  db.insert(queries).values({
    id, projectId, query, createdAt: NOW,
  }).run()
  return id
}

function seedSnapshot(runId: string, queryId: string, answerText: string): void {
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId,
    queryText: 'example query',
    provider: 'gemini',
    citationState: CitationStates.cited,
    answerMentioned: true,
    answerText,
    createdAt: NOW,
  }).run()
}

function seedAudit(projectId: string, action: string): void {
  db.insert(auditLog).values({
    id: crypto.randomUUID(), projectId, actor: 'api', action,
    entityType: 'project', entityId: projectId, diff: null, createdAt: NOW,
  }).run()
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-scope-test-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  projectAId = seedProject('project-a')
  projectBId = seedProject('project-b')
  runAId = seedRun(projectAId)
  runBId = seedRun(projectBId)
  seedSnapshot(runAId, seedQuery(projectAId, 'best project a'), 'project-a private answer')
  seedSnapshot(runBId, seedQuery(projectBId, 'best project b'), 'project-b private answer')
  seedAudit(projectAId, 'project.applied')
  seedAudit(projectBId, 'project.applied')
  rootKeyId = seedKey('root', ROOT_KEY, ['*'])
  scopedKeyId = seedKey('scoped', SCOPED_KEY, ['read', 'embed'], projectAId)
  seedKey('scoped-write', SCOPED_WRITE_KEY, ['*'], projectAId)
  scopedBKeyId = seedKey('scoped-b', SCOPED_B_KEY, ['read'], projectBId)

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

  it('a scoped key gets the SAME denial for an unknown project name (no name probing)', async () => {
    const res = await authed('GET', '/api/v1/projects/not-a-real-project', SCOPED_KEY)
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

  it('a scoped key cannot smuggle a sibling run into project snapshot diff', async () => {
    const res = await authed('GET', `/api/v1/projects/project-a/snapshots/diff?run1=${runAId}&run2=${runBId}`, SCOPED_KEY)
    expect(res.statusCode).toBe(404)
  })

  it('a scoped key CAN diff runs from its own project', async () => {
    const res = await authed('GET', `/api/v1/projects/project-a/snapshots/diff?run1=${runAId}&run2=${runAId}`, SCOPED_KEY)
    expect(res.statusCode).toBe(200)
    expect(JSON.stringify(res.json())).not.toContain('project-b private answer')
  })

  it('a full-instance key reads any project + any run (unchanged)', async () => {
    expect((await authed('GET', '/api/v1/projects/project-b', ROOT_KEY)).statusCode).toBe(200)
    expect((await authed('GET', `/api/v1/runs/${runBId}`, ROOT_KEY)).statusCode).toBe(200)
  })

  it('GET /keys returns ONLY same-project scoped keys for a scoped key', async () => {
    const res = await authed('GET', '/api/v1/keys', SCOPED_KEY)
    expect(res.statusCode).toBe(200)
    const keys = (res.json() as { keys: Array<{ id: string; projectId: string | null }> }).keys
    expect(new Set(keys.map(key => key.projectId))).toEqual(new Set([projectAId]))
    expect(keys.map(key => key.id)).not.toContain(rootKeyId)
    expect(keys.map(key => key.id)).not.toContain(scopedBKeyId)
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

  // --- global aggregation endpoints (NOT under the /projects/:name URL gate) ---

  it('GET /runs returns ONLY the scoped project\'s runs', async () => {
    const res = await authed('GET', '/api/v1/runs', SCOPED_KEY)
    expect(res.statusCode).toBe(200)
    const pids = new Set((res.json() as Array<{ projectId: string }>).map(r => r.projectId))
    expect(pids).toEqual(new Set([projectAId]))
  })

  it('GET /runs returns ALL projects\' runs for a full-instance key', async () => {
    const res = await authed('GET', '/api/v1/runs', ROOT_KEY)
    const pids = new Set((res.json() as Array<{ projectId: string }>).map(r => r.projectId))
    expect(pids).toEqual(new Set([projectAId, projectBId]))
  })

  it('GET /history returns ONLY the scoped project\'s audit log', async () => {
    const res = await authed('GET', '/api/v1/history', SCOPED_KEY)
    expect(res.statusCode).toBe(200)
    const pids = new Set((res.json() as Array<{ projectId: string }>).map(r => r.projectId))
    expect(pids).toEqual(new Set([projectAId]))
  })

  it('GET /history returns ALL audit entries for a full-instance key', async () => {
    const res = await authed('GET', '/api/v1/history', ROOT_KEY)
    const pids = new Set((res.json() as Array<{ projectId: string }>).map(r => r.projectId))
    expect(pids).toEqual(new Set([projectAId, projectBId]))
  })

  it('POST /runs (batch) triggers ONLY the scoped project for a scoped write key', async () => {
    const res = await authed('POST', '/api/v1/runs', SCOPED_WRITE_KEY, { kind: 'answer-visibility' })
    expect(res.statusCode).toBe(207)
    const pids = new Set((res.json() as Array<{ projectId: string }>).map(r => r.projectId))
    expect(pids).toEqual(new Set([projectAId]))
  })

  it('POST /apply is FORBIDDEN for a scoped key applying a SIBLING project', async () => {
    const res = await authed('POST', '/api/v1/apply', SCOPED_WRITE_KEY, {
      apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'project-b' },
      spec: { displayName: 'B', canonicalDomain: 'project-b.example', country: 'US', language: 'en' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('POST /apply ALLOWS a scoped key applying its OWN project', async () => {
    const res = await authed('POST', '/api/v1/apply', SCOPED_WRITE_KEY, {
      apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'project-a' },
      spec: { displayName: 'A', canonicalDomain: 'project-a.example', country: 'US', language: 'en' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('POST /keys is FORBIDDEN when a scoped key mints an UNSCOPED key (no escalation)', async () => {
    const res = await authed('POST', '/api/v1/keys', SCOPED_WRITE_KEY, { name: 'escalate', scopes: ['*'] })
    expect(res.statusCode).toBe(403)
  })

  it('POST /keys/:id/revoke is FORBIDDEN when a scoped key targets a full-instance key', async () => {
    const res = await authed('POST', `/api/v1/keys/${rootKeyId}/revoke`, SCOPED_WRITE_KEY)
    expect(res.statusCode).toBe(403)
  })

  it('POST /keys/:id/revoke is FORBIDDEN when a scoped key targets a sibling project key', async () => {
    const res = await authed('POST', `/api/v1/keys/${scopedBKeyId}/revoke`, SCOPED_WRITE_KEY)
    expect(res.statusCode).toBe(403)
  })

  it('POST /keys/:id/revoke ALLOWS a scoped key revoking another key from its OWN project', async () => {
    const res = await authed('POST', `/api/v1/keys/${scopedKeyId}/revoke`, SCOPED_WRITE_KEY)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { revokedAt: string | null }).revokedAt).not.toBeNull()
  })

  it('POST /keys ALLOWS a scoped key minting a key for its OWN project', async () => {
    const res = await authed('POST', '/api/v1/keys', SCOPED_WRITE_KEY, { name: 'ok', scopes: ['read'], projectId: projectAId })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { projectId: string }).projectId).toBe(projectAId)
  })
})
