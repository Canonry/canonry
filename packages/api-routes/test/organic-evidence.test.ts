import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createClient,
  gaTrafficSnapshots,
  gscDailyTotals,
  gscSearchData,
  migrate,
  projects,
  runs,
} from '@ainyc/canonry-db'
import { organicEvidenceDtoSchema, type OrganicEvidenceDto } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-organic-evidence-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir }
}

let ctx: ReturnType<typeof buildApp>
beforeEach(() => { ctx = buildApp() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

function seedEvidence() {
  const now = '2026-07-23T12:00:00.000Z'
  const projectId = crypto.randomUUID()
  ctx.db.insert(projects).values({
    id: projectId,
    name: 'example-solar',
    displayName: 'Example Solar',
    canonicalDomain: 'example.com',
    aliases: ['ExampleSolar'],
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  const runId = crypto.randomUUID()
  ctx.db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'gsc-sync',
    status: 'completed',
    trigger: 'manual',
    createdAt: now,
    finishedAt: now,
  }).run()

  for (const row of [
    { date: '2026-06-20', clicks: 20, impressions: 1_000 },
    { date: '2026-07-20', clicks: 19, impressions: 1_100 },
  ]) {
    ctx.db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(), projectId, position: '5', createdAt: now, ...row,
    }).run()
  }
  for (const row of [
    { date: '2026-06-20', page: 'https://www.example.com/resources/old-guide?utm_source=x', clicks: 4, impressions: 313 },
    { date: '2026-07-20', page: 'https://example.com/answer-library/new-guide', clicks: 0, impressions: 495 },
  ]) {
    ctx.db.insert(gscSearchData).values({
      id: crypto.randomUUID(), projectId, syncRunId: runId, query: 'solar estimate software',
      ctr: '0', position: '8', createdAt: now, ...row,
    }).run()
  }
  for (const row of [
    { date: '2026-06-20', landingPage: '/resources/old-guide', organicSessions: 35 },
    { date: '2026-07-20', landingPage: '/answer-library/new-guide', organicSessions: 16 },
    // GA is fresher than GSC. This row must not create a synthetic GSC zero tail.
    { date: '2026-07-23', landingPage: '/answer-library/new-guide', organicSessions: 999 },
  ]) {
    ctx.db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(), projectId, sessions: row.organicSessions,
      users: row.organicSessions, syncedAt: now, ...row,
    }).run()
  }
}

async function getEvidence(period = 90): Promise<OrganicEvidenceDto> {
  await ctx.app.ready()
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/projects/example-solar/organic-evidence?period=${period}`,
  })
  expect(response.statusCode).toBe(200)
  return organicEvidenceDtoSchema.parse(JSON.parse(response.body))
}

describe('organic evidence composite', () => {
  it('uses independent source-specific GSC and GA4 cohort dates', async () => {
    seedEvidence()
    const body = await getEvidence(90)

    expect(body.asOfDate).toBe('2026-07-20')
    expect(body).not.toHaveProperty('cohorts')
    expect(body).not.toHaveProperty('blog')
    expect(body.gsc?.cohorts).toEqual([
      { name: 'earliest', startDate: '2026-04-22', endDate: '2026-05-21', totals: { clicks: 0, impressions: 0 } },
      { name: 'middle', startDate: '2026-05-22', endDate: '2026-06-20', totals: { clicks: 20, impressions: 1_000 } },
      { name: 'latest', startDate: '2026-06-21', endDate: '2026-07-20', totals: { clicks: 19, impressions: 1_100 } },
    ])
    expect(body.ga4?.cohorts).toEqual([
      { name: 'earliest', startDate: '2026-04-25', endDate: '2026-05-24', organicSessions: 0 },
      { name: 'middle', startDate: '2026-05-25', endDate: '2026-06-23', organicSessions: 35 },
      { name: 'latest', startDate: '2026-06-24', endDate: '2026-07-23', organicSessions: 1_015 },
    ])
    expect(body.ga4?.organicSessions).toBe(1_050)
    expect(body.ga4).not.toHaveProperty('blogOrganicSessions')
    expect(body.sourceCoverage.ga4?.endDate).toBe('2026-07-23')
    expect(body.limitations).toContainEqual(expect.objectContaining({
      code: 'source-specific-cohort-anchors',
    }))
  })

  it('normalizes every landing URL into page evidence and emits sitewide findings', async () => {
    seedEvidence()
    const body = await getEvidence(90)

    expect(body.pages.map(row => row.path)).toEqual(expect.arrayContaining([
      '/answer-library/new-guide',
      '/resources/old-guide',
    ]))
    expect(body.findings).toContainEqual(expect.objectContaining({
      tone: 'positive',
      title: 'Search visibility increased',
      detail: expect.stringContaining('1100 in the latest cohort versus 1000 prior (+10%)'),
    }))
    expect(body.findings).toContainEqual(expect.objectContaining({
      tone: 'caution',
      title: 'Search clicks have not followed visibility yet',
    }))
    expect(body.limitations).toContainEqual(expect.objectContaining({ code: 'no-lead-attribution' }))
  })

  it('returns two source-specific 30-day cohorts for 60 days and rejects unsupported periods', async () => {
    seedEvidence()
    const body = await getEvidence(60)
    expect(body.gsc?.cohorts.map(row => row.name)).toEqual(['prior', 'latest'])
    expect(body.ga4?.cohorts.map(row => row.name)).toEqual(['prior', 'latest'])

    const invalid = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/example-solar/organic-evidence?period=30',
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('documents URL-agnostic page evidence and source-specific dates in OpenAPI', async () => {
    seedEvidence()
    await ctx.app.ready()
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(response.statusCode).toBe(200)
    const spec = JSON.parse(response.body) as {
      paths: Record<string, { get?: { description?: string } }>
    }
    const description = spec.paths['/api/v1/projects/{name}/organic-evidence']?.get?.description ?? ''
    expect(description).toMatch(/source-specific/i)
    expect(description).toMatch(/page evidence/i)
    expect(description).not.toMatch(/blog/i)
    expect(description).not.toMatch(/shared (date|cohort)/i)
  })
})
