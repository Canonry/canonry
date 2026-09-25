/**
 * End-to-end test that the GSC top-queries categorizer correctly tags
 * brand-name variants. Reproduces the Harbor IQ misclassification bug
 * where "harbor iq" / "harboriq" / "harbor iq login" all landed in
 * "other" instead of "brand".
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  gscSearchData,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ProjectReportDto } from '@ainyc/canonry-contracts'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-brand-'))
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

function seedHarborIqWithGscQueries(
  db: ReturnType<typeof createClient>,
  queries: Array<[string, number]>,
) {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'harbor-iq',
    displayName: 'Harbor IQ',
    canonicalDomain: 'harbor-iq.test',
    country: 'US',
    language: 'en',
    locations: '[]',
    providers: '["gemini"]',
    createdAt: now,
    updatedAt: now,
  }).run()
  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: now,
    finishedAt: now,
  }).run()
  for (const [query, impressions] of queries) {
    db.insert(gscSearchData).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: runId,
      date: '2026-04-01',
      query,
      page: '/p',
      impressions,
      clicks: Math.floor(impressions / 10),
      ctr: '0.1',
      position: '4',
      createdAt: now,
    }).run()
  }
}

describe('GSC brand classifier, harbor-iq.test', () => {
  test('tags "harbor iq", "harboriq", "harbor iq login" as brand', async () => {
    seedHarborIqWithGscQueries(ctx.db, [
      ['harbor iq', 187],
      ['harboriq', 93],
      ['harbor iq login', 9],
    ])

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/harbor-iq/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const byQuery = Object.fromEntries(body.gsc!.topQueries.map(q => [q.query, q.category]))
    expect(byQuery['harbor iq']).toBe('brand')
    expect(byQuery['harboriq']).toBe('brand')
    expect(byQuery['harbor iq login']).toBe('brand')
  })

  test('non-brand queries do not get brand-tagged', async () => {
    seedHarborIqWithGscQueries(ctx.db, [
      ['roofing estimate calculator', 100],
      ['hvac contractor near me', 50],
    ])

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/harbor-iq/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const categories = body.gsc!.topQueries.map(q => q.category)
    expect(categories).not.toContain('brand')
  })

  test('brand share appears in categoryBreakdown when brand queries exist', async () => {
    seedHarborIqWithGscQueries(ctx.db, [
      ['harbor iq', 100], // brand
      ['hvac estimator', 50], // not brand
    ])

    await ctx.app.ready()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/harbor-iq/report' })
    const body = JSON.parse(res.body) as ProjectReportDto

    const brand = body.gsc!.categoryBreakdown.find(c => c.category === 'brand')
    expect(brand).toBeDefined()
    expect(brand!.clicks).toBeGreaterThan(0)
  })
})
