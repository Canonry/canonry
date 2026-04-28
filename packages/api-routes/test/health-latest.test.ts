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
    totalPairs: 0,
    citedPairs: 0,
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
    totalPairs: 10,
    citedPairs: 4,
    providerBreakdown: JSON.stringify({ gemini: { citedRate: 0.5, cited: 5, total: 10 } }),
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
  expect(body.providerBreakdown).toEqual({ gemini: { citedRate: 0.5, cited: 5, total: 10 } })
})

test('still returns 404 when the project itself does not exist', async () => {
  await ctx.app.ready()
  const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/missing/health/latest' })
  expect(res.statusCode).toBe(404)
  expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND')
})
