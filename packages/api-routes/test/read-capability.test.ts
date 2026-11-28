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
import { measurementPlanV2Fixture, publishPlanV2, seedPlanV2Sweep } from './measurement-plan-v2-fixture.js'

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
const SCOPED_KEY = 'cnry_scopedtoken' // dashboard bundle, project-a only
let projectAId: string

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
  // A second Simple project, for the cross-project boundary.
  seedProject('project-b')
  // A dashboard key bound to project-a only.
  seedKey('scoped', SCOPED_KEY, ['dashboard.read'], projectAId)
  // An Advanced (custom) portfolio: active schema-v2 plan + one completed sweep.
  const projectAdvId = seedProject('project-adv')
  const plan = measurementPlanV2Fixture()
  const versionId = publishPlanV2(db, projectAdvId, plan, NOW)
  seedPlanV2Sweep(db, {
    projectId: projectAdvId,
    runId: crypto.randomUUID(),
    versionId,
    plan,
    createdAt: NOW,
    answer: () => ({ answerText: 'Northstar is well reviewed.', citedUrls: ['https://northstar.example/'] }),
  })

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

  it('a dashboard key reads dashboard surfaces but is denied query lists and analytics', async () => {
    // Default-deny on the newly classified surfaces (#817): the dashboard
    // bundle opens the overview, not the query lists or the wider analytics.
    expect((await authed('GET', '/api/v1/projects/project-a/overview', DASHBOARD_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/queries', DASHBOARD_KEY)).statusCode).toBe(403)
    expect((await authed('GET', '/api/v1/projects/project-a/keywords', DASHBOARD_KEY)).statusCode).toBe(403)
    expect((await authed('GET', '/api/v1/projects/project-a/analytics/gaps', DASHBOARD_KEY)).statusCode).toBe(403)
  })

  it('a full-read key reads the query lists', async () => {
    expect((await authed('GET', '/api/v1/projects/project-a/queries', FULL_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-a/keywords', FULL_KEY)).statusCode).toBe(200)
  })

  it('an analytics key reads the Advanced measurement overview but a dashboard key does not', async () => {
    expect((await authed('GET', '/api/v1/projects/project-adv/measurement-overview?scope=all', ANALYTICS_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-adv/measurement-overview?scope=all', FULL_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-adv/measurement-overview?scope=all', DASHBOARD_KEY)).statusCode).toBe(403)
    expect((await authed('GET', '/api/v1/projects/project-adv/measurement-overview?scope=all', NARROW_KEY)).statusCode).toBe(403)
    expect((await authed('GET', '/api/v1/projects/project-adv/measurement-overview?scope=all', EMBED_KEY)).statusCode).toBe(403)
    // The dashboard bundle still opens the overview on an Advanced project.
    expect((await authed('GET', '/api/v1/projects/project-adv/overview', DASHBOARD_KEY)).statusCode).toBe(200)
  })

  it('a legacy read key keeps full access on an Advanced project, an embed key keeps dashboard only', async () => {
    expect((await authed('GET', '/api/v1/projects/project-adv/measurement-overview?scope=all', READ_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-adv/queries', READ_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-adv/overview', EMBED_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-adv/queries', EMBED_KEY)).statusCode).toBe(403)
  })

  it('exempt routes keep their own gates (exemption is not an open door)', async () => {
    // The caller's own key row: metadata about itself, any key may read it.
    expect((await authed('GET', '/api/v1/keys/self', DASHBOARD_KEY)).statusCode).toBe(200)
    // The MCP profile is exempt from the capability default-deny, so a
    // dashboard key is refused by the route's own requireScope('read') — the
    // message names the scope, not the full.read capability — while a
    // wildcard key passes that scope and is refused by the route's own
    // named-account gate instead. Neither refusal comes from default-deny.
    const dashboardProfile = await authed('GET', '/api/v1/mcp/profile', DASHBOARD_KEY)
    expect(dashboardProfile.statusCode).toBe(403)
    expect((dashboardProfile.json() as { error: { message: string } }).error.message)
      .toBe('This action requires the "read" scope on your API key.')
    const rootProfile = await authed('GET', '/api/v1/mcp/profile', ROOT_KEY)
    expect(rootProfile.statusCode).toBe(403)
    expect((rootProfile.json() as { error: { message: string } }).error.message)
      .toBe('MCP connection profiles require an instance-wide named account.')
    // Operational logs need an operator key; this harness mints none, so
    // even the wildcard key is refused — the exemption never opens the route.
    expect((await authed('GET', '/api/v1/operations/logs', ROOT_KEY)).statusCode).toBe(403)
    expect((await authed('GET', '/api/v1/operations/logs', DASHBOARD_KEY)).statusCode).toBe(403)
  })

  it('a paid read keeps its own gate', async () => {
    // OpenAI Ads live reads need a wildcard or ads grant; a dashboard key
    // is refused by that gate, not by the capability default-deny.
    expect((await authed('GET', '/api/v1/projects/project-a/ads/account', DASHBOARD_KEY)).statusCode).toBe(403)
    expect((await authed('GET', '/api/v1/projects/project-a/ads/account', ROOT_KEY)).statusCode).not.toBe(403)
  })

  it('a project-scoped key cannot read another project', async () => {
    expect((await authed('GET', '/api/v1/projects/project-a/overview', SCOPED_KEY)).statusCode).toBe(200)
    expect((await authed('GET', '/api/v1/projects/project-b/overview', SCOPED_KEY)).statusCode).toBe(403)
    expect((await authed('GET', '/api/v1/projects/project-b/queries', SCOPED_KEY)).statusCode).toBe(403)
  })
})
