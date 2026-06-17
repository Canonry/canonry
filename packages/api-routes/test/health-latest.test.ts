import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { beforeEach, expect, test } from 'vitest'
import { createClient, migrate, projects, healthSnapshots } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { HealthSnapshotDto } from '@ainyc/canonry-contracts'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-health-latest-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

function insertProject(db: ReturnType<typeof createClient>, name: string) {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id,
    name,
    displayName: name,
    canonicalDomain: `${name}.example.com`,
    country: 'US',
    language: 'en',
    locations: '[]',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run()
  return id
}

let ctx: ReturnType<typeof buildApp>

beforeEach(() => {
  ctx = buildApp()
  return async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  }
})

test('returns 200 with no-data sentinel when no health snapshot exists', async () => {
  const projectId = insertProject(ctx.db, 'fresh')
  await ctx.app.ready()

  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/fresh/health/latest' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as HealthSnapshotDto
  expect(body).toEqual({
    id: `no-data:${projectId}`,
    projectId,
    runId: null,
    overallCitedRate: 0,
    overallMentionRate: 0,
    totalPairs: 0,
    citedPairs: 0,
    mentionedPairs: 0,
    providerBreakdown: {},
    createdAt: '',
    status: 'no-data',
    reason: 'no-runs-yet',
  })
})

test('returns 200 with status:"ready" when a snapshot exists', async () => {
  const projectId = insertProject(ctx.db, 'has-data')
  ctx.db.insert(healthSnapshots).values({
    id: 'snap-1',
    projectId,
    runId: null,
    overallCitedRate: 0.42,
    overallMentionRate: 0.3,
    totalPairs: 10,
    citedPairs: 4,
    mentionedPairs: 3,
    providerBreakdown: { gemini: { citedRate: 0.5, mentionRate: 0.3, cited: 5, mentioned: 3, total: 10 } },
    createdAt: '2026-04-27T00:00:00Z',
  }).run()
  await ctx.app.ready()

  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/has-data/health/latest' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as HealthSnapshotDto
  expect(body.status).toBe('ready')
  expect(body.reason).toBeUndefined()
  expect(body.overallCitedRate).toBe(0.42)
  expect(body.citedPairs).toBe(4)
  expect(body.totalPairs).toBe(10)
  // Mention is surfaced alongside cited, never in place of it.
  expect(body.overallMentionRate).toBe(0.3)
  expect(body.mentionedPairs).toBe(3)
  expect(body.providerBreakdown).toEqual({ gemini: { citedRate: 0.5, mentionRate: 0.3, cited: 5, mentioned: 3, total: 10 } })
})

test('coalesces a legacy row with NULL mention columns to 0 instead of crashing', async () => {
  const projectId = insertProject(ctx.db, 'legacy-row')
  // Simulate a row persisted before the v80 mention migration: the mention
  // columns are NULL and the providerBreakdown JSON has no mention keys.
  ctx.db.insert(healthSnapshots).values({
    id: 'legacy-1',
    projectId,
    runId: null,
    overallCitedRate: 0.6,
    overallMentionRate: null,
    totalPairs: 10,
    citedPairs: 6,
    mentionedPairs: null,
    // Cast: this is intentionally the OLD JSON shape with no mention keys.
    providerBreakdown: { gemini: { citedRate: 0.6, cited: 6, total: 10 } } as never,
    createdAt: '2026-04-20T00:00:00Z',
  }).run()
  await ctx.app.ready()

  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/legacy-row/health/latest' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as HealthSnapshotDto
  expect(body.status).toBe('ready')
  // Cited fields read through unchanged.
  expect(body.overallCitedRate).toBe(0.6)
  expect(body.citedPairs).toBe(6)
  // Missing mention data reads back as 0 (NULL→0), not NaN/null/undefined.
  expect(body.overallMentionRate).toBe(0)
  expect(body.mentionedPairs).toBe(0)
  expect(body.providerBreakdown.gemini).toEqual({ citedRate: 0.6, mentionRate: 0, cited: 6, mentioned: 0, total: 10 })
})

test('still returns 404 when the project itself does not exist', async () => {
  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/missing/health/latest' })
  expect(res.statusCode).toBe(404)
  expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
})

test('aggregates healthSnapshots across the latest fan-out group when a multi-location sweep wrote one snapshot per location (#480)', async () => {
  const { runs } = await import('@ainyc/canonry-db')
  const projectId = insertProject(ctx.db, 'multi-loc-health')
  const createdAt = '2026-05-13T17:23:20.060Z'
  const flRunId = '00000000-0000-0000-0000-0000000000ff'
  const miRunId = 'ffffffff-ffff-ffff-ffff-ffffffffff00'

  // Two runs, one per location, same `createdAt`.
  ctx.db.insert(runs).values([
    { id: flRunId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'florida',  createdAt, finishedAt: createdAt },
    { id: miRunId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: 'michigan', createdAt, finishedAt: createdAt },
  ]).run()

  // florida: 6 of 10 pairs cited, 4 mentioned. michigan: 2 of 10 cited, 1 mentioned.
  // Project-level aggregate: cited 8/20 (40%), mentioned 5/20 (25%).
  ctx.db.insert(healthSnapshots).values([
    {
      id: 'snap-fl',
      projectId,
      runId: flRunId,
      overallCitedRate: '0.6',
      overallMentionRate: '0.4',
      totalPairs: 10,
      citedPairs: 6,
      mentionedPairs: 4,
      providerBreakdown: { gemini: { citedRate: 0.6, mentionRate: 0.4, cited: 6, mentioned: 4, total: 10 } },
      createdAt,
    },
    {
      id: 'snap-mi',
      projectId,
      runId: miRunId,
      overallCitedRate: '0.2',
      overallMentionRate: '0.1',
      totalPairs: 10,
      citedPairs: 2,
      mentionedPairs: 1,
      providerBreakdown: { gemini: { citedRate: 0.2, mentionRate: 0.1, cited: 2, mentioned: 1, total: 10 } },
      createdAt,
    },
  ]).run()

  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/multi-loc-health/health/latest' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.body) as HealthSnapshotDto

  // Sums across both locations:
  expect(body.totalPairs).toBe(20)
  expect(body.citedPairs).toBe(8)
  expect(body.overallCitedRate).toBeCloseTo(0.4, 5)

  // Mention sums independently of cited: 4 + 1 = 5 over 20 = 25%.
  expect(body.mentionedPairs).toBe(5)
  expect(body.overallMentionRate).toBeCloseTo(0.25, 5)

  // Per-provider breakdown also aggregated — cited AND mention merged.
  expect(body.providerBreakdown.gemini?.total).toBe(20)
  expect(body.providerBreakdown.gemini?.cited).toBe(8)
  expect(body.providerBreakdown.gemini?.citedRate).toBeCloseTo(0.4, 5)
  expect(body.providerBreakdown.gemini?.mentioned).toBe(5)
  expect(body.providerBreakdown.gemini?.mentionRate).toBeCloseTo(0.25, 5)

  // Synthesized id signals this is a group aggregate.
  expect(body.id).toMatch(/^group:/)
})
