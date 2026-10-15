import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, runs, querySnapshots } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * `measurementExecutionIdentity` is stamped onto every plan-aware run at
 * queue time (`run-queue.ts`), but that write is only half the promise: an
 * engine or model swap is supposed to start a new comparable series with a
 * VISIBLE break. `GET /projects/:name/analytics/metrics` is where that
 * promise is read back, mirroring the existing `basketChanges` annotation
 * for query-set revisions.
 */

const IDENTITY_A = {
  schemaVersion: 1 as const,
  providers: ['openai'],
  models: { openai: 'gpt-a' },
  checksum: 'a'.repeat(64),
}
const IDENTITY_B = {
  schemaVersion: 1 as const,
  providers: ['openai'],
  models: { openai: 'gpt-b' },
  checksum: 'b'.repeat(64),
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-execution-identity-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

function insertProject(db: ReturnType<typeof createClient>) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name: 'identity-boundary',
    displayName: 'Identity Boundary Co',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    locations: [],
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

function insertRun(
  db: ReturnType<typeof createClient>,
  projectId: string,
  createdAt: string,
  identity: typeof IDENTITY_A | null,
) {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    location: null,
    startedAt: createdAt,
    finishedAt: createdAt,
    measurementExecutionIdentity: identity,
    createdAt,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: id,
    queryId: null,
    queryText: 'widget pricing',
    provider: 'openai',
    citationState: 'not-cited',
    answerText: 'a fake answer',
    citedDomains: [],
    competitorOverlap: [],
    recommendedCompetitors: [],
    location: null,
    createdAt,
  }).run()
  return id
}

let ctx: ReturnType<typeof buildApp>

beforeEach(async () => {
  ctx = buildApp()
  await ctx.app.ready()
})

afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

describe('GET /projects/:name/analytics/metrics executionIdentityChanges', () => {
  it('marks the run where the execution identity checksum actually changed, not the ones that repeat it', async () => {
    const projectId = insertProject(ctx.db)
    const projectName = 'identity-boundary'

    insertRun(ctx.db, projectId, '2026-07-01T00:00:00.000Z', IDENTITY_A)
    insertRun(ctx.db, projectId, '2026-07-08T00:00:00.000Z', IDENTITY_A)
    const swapRunId = insertRun(ctx.db, projectId, '2026-07-15T00:00:00.000Z', IDENTITY_B)
    insertRun(ctx.db, projectId, '2026-07-22T00:00:00.000Z', IDENTITY_B)

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectName}/analytics/metrics?window=all`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { executionIdentityChanges: Array<{ at: string; identity: typeof IDENTITY_B }> }

    expect(body.executionIdentityChanges).toHaveLength(1)
    expect(body.executionIdentityChanges[0]!.at).toBe('2026-07-15T00:00:00.000Z')
    expect(body.executionIdentityChanges[0]!.identity).toEqual(IDENTITY_B)
    void swapRunId
  })

  it('reports no boundary for a project whose runs never carried an execution identity', async () => {
    const projectId = insertProject(ctx.db)
    const projectName = 'identity-boundary'

    insertRun(ctx.db, projectId, '2026-07-01T00:00:00.000Z', null)
    insertRun(ctx.db, projectId, '2026-07-08T00:00:00.000Z', null)

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectName}/analytics/metrics?window=all`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { executionIdentityChanges: unknown[] }
    expect(body.executionIdentityChanges).toEqual([])
  })
})
