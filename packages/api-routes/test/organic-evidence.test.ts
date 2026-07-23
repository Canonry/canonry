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
    { date: '2026-07-20', clicks: 21, impressions: 1_100 },
  ]) {
    ctx.db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(), projectId, position: '5', createdAt: now, ...row,
    }).run()
  }
  for (const row of [
    { date: '2026-06-20', page: 'https://www.example.com/blog/old-post?utm_source=x', clicks: 4, impressions: 313 },
    { date: '2026-07-20', page: 'https://example.com/blog/new-post', clicks: 0, impressions: 495 },
  ]) {
    ctx.db.insert(gscSearchData).values({
      id: crypto.randomUUID(), projectId, syncRunId: runId, query: 'solar estimate software',
      ctr: '0', position: '8', createdAt: now, ...row,
    }).run()
  }
  for (const row of [
    { date: '2026-06-20', landingPage: '/blog/old-post', organicSessions: 35 },
    { date: '2026-07-20', landingPage: '/blog/new-post', organicSessions: 16 },
    // GA is fresher than GSC. This row must not create a synthetic GSC zero tail.
    { date: '2026-07-23', landingPage: '/blog/new-post', organicSessions: 999 },
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
  it('uses fixed 30-day cohorts on the latest GSC/GA4 shared date', async () => {
    seedEvidence()
    const body = await getEvidence(90)

    expect(body.asOfDate).toBe('2026-07-20')
    expect(body.cohorts).toEqual([
      { name: 'earliest', startDate: '2026-04-22', endDate: '2026-05-21' },
      { name: 'middle', startDate: '2026-05-22', endDate: '2026-06-20' },
      { name: 'latest', startDate: '2026-06-21', endDate: '2026-07-20' },
    ])
    expect(body.ga4?.organicSessions).toBe(51)
    expect(body.sourceCoverage.ga4?.endDate).toBe('2026-07-23')
  })

  it('normalizes full GSC URLs into the blog path cohort and emits bounded findings', async () => {
    seedEvidence()
    const body = await getEvidence(90)

    expect(body.blog.gsc?.cohorts.map(row => row.totals.impressions)).toEqual([0, 313, 495])
    expect(body.pages.map(row => row.path)).toEqual(expect.arrayContaining(['/blog/new-post', '/blog/old-post']))
    expect(body.findings).toContainEqual(expect.objectContaining({
      tone: 'positive',
      title: 'Blog search visibility increased',
      detail: expect.stringContaining('495 in the latest cohort versus 313 prior (+58%)'),
    }))
    expect(body.findings).toContainEqual(expect.objectContaining({
      tone: 'caution',
      title: 'Blog clicks have not followed visibility yet',
    }))
    expect(body.limitations).toContainEqual(expect.objectContaining({ code: 'no-lead-attribution' }))
  })

  it('returns two 30-day cohorts for 60 days and rejects unsupported periods', async () => {
    seedEvidence()
    const body = await getEvidence(60)
    expect(body.cohorts.map(row => row.name)).toEqual(['prior', 'latest'])

    const invalid = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/example-solar/organic-evidence?period=30',
    })
    expect(invalid.statusCode).toBe(400)
  })
})
