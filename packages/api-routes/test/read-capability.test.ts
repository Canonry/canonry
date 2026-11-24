import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, apiKeys, projects, queries, querySnapshots, runs, type DatabaseClient } from '@canonry/canonry-db'
import { CitationStates } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

/**
 * Capability-based read scoping (#817). Read routes declare the capability
 * they require in their route config (`readCapability`); the auth plugin
 * enforces it centrally with default deny (403). Capabilities are scope
 * tokens ending in `.read`: `dashboard.read` (visibility/dashboard),
 * `analytics.read` (broader analytics, includes dashboard), `full.read`
 * (exports, raw runs, full query lists; includes both bundles). The
 * wildcard and legacy `read` map to every capability, so existing keys keep
 * reading exactly what they read today; `embed` maps to the dashboard
 * bundle only. A key carrying an unrelated read scope (`users.read`) gets
 * no capability and is denied on tagged routes.
 */
let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

const NOW = new Date().toISOString()
const ROOT_KEY = 'cnry_roottoken' // wildcard, full instance
const READ_KEY = 'cnry_readtoken' // legacy read
const DASHBOARD_KEY = 'cnry_dashtoken' // dashboard bundle only
const ANALYTICS_KEY = 'cnry_anatoken' // analytics bundle (includes dashboard)
const FULL_KEY = 'cnry_fulltoken' // full read (includes both bundles)
const NARROW_KEY = 'cnry_narrowtoken' // unrelated read scope: no capability
const EMBED_KEY = 'cnry_embedtoken' // embed: dashboard bundle only
let projectAId: string

function seedKey(name: string, raw: string, scopes: string[]): string {
  const id = crypto.randomUUID()
  db.insert(apiKeys).values({
    id, name, keyHash: hashApiKey(raw), keyPrefix: raw.slice(0, 9),
    scopes, projectId: null, createdAt: NOW,
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-capability-test-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  projectAId = seedProject('project-a')
  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId, projectId: projectAId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: NOW, finishedAt: NOW,
  }).run()
  const queryId = crypto.randomUUID()
  db.insert(queries).values({
    id: queryId, projectId: projectAId, query: 'best project a', createdAt: NOW,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId,
    queryId,
    queryText: 'best project a',
    provider: 'gemini',
    citationState: CitationStates.cited,
    answerMentioned: true,
    answerText: 'answer text',
    createdAt: NOW,
  }).run()
  seedKey('root', ROOT_KEY, ['*'])
  seedKey('read', READ_KEY, ['read'])
  seedKey('dashboard', DASHBOARD_KEY, ['dashboard.read'])
  seedKey('analytics', ANALYTICS_KEY, ['analytics.read'])
  seedKey('full', FULL_KEY, ['full.read'])
  seedKey('narrow', NARROW_KEY, ['users.read'])
  seedKey('embed', EMBED_KEY, ['embed'])

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

describe('capability-based read scoping', () => {
  it('a wildcard key reads every tagged surface (200)', async () => {
    expect((await authed('GET', '/api/v1/projects/project-a/visibility-report', ROOT_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/results/export', ROOT_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/runs', ROOT_KEY)).statusCode).toBe(200)
  })

  it('a legacy read key keeps every capability (backward compat)', async () => {
    expect((await authed('GET', '/api/v1/projects/project-a/visibility-report', READ_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/results/export', READ_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/runs', READ_KEY)).statusCode).toBe(200)
  })

  it('a dashboard key reads the dashboard bundle but not export or runs', async () => {
    expect((await authed('GET', '/api/v1/projects/project-a/visibility-report', DASHBOARD_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/competitors', DASHBOARD_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/results/export', DASHBOARD_KEY)).statusCode).toBe(403)
    expect((await authed('GET', '/api/v1/runs', DASHBOARD_KEY)).statusCode).toBe(403)
  })

  it('an analytics key reads dashboard + analytics but not full read', async () => {
    expect((await authed('GET', '/api/v1/projects/project-a/visibility-report', ANALYTICS_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/analytics/gaps', ANALYTICS_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/results/export', ANALYTICS_KEY)).statusCode).toBe(403)
    expect((await authed('GET', '/api/v1/runs', ANALYTICS_KEY)).statusCode).toBe(403)
  })

  it('a full-read key reads exports, runs and query lists', async () => {
    expect((await authed('GET', '/api/v1/projects/project-a/results/export', FULL_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/runs', FULL_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/query-tracking', FULL_KEY)).statusCode).toBe(200)
  })

  it('a key with an unrelated read scope is denied on tagged routes (default deny)', async () => {
    const res = await authed('GET', '/api/v1/projects/project-a/visibility-report', NARROW_KEY)
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('an embed key reads the dashboard bundle but not full read', async () => {
    expect((await authed('GET', '/api/v1/projects/project-a/visibility-report', EMBED_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/results/export', EMBED_KEY)).statusCode).toBe(403)
  })
})
