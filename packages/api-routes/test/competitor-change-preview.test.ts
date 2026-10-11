import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { competitors, createClient, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { competitorChangePreviewResponseSchema } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

const NOW = '2026-08-20T12:00:00.000Z'
let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-competitor-change-preview-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'project_preview', name: 'preview', displayName: 'Northwind', canonicalDomain: 'northwind.example',
    ownedDomains: [], country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(competitors).values({ id: 'preview_rival', projectId: 'project_preview', domain: 'rival.example', provenance: 'manual', createdAt: NOW }).run()
  db.insert(queries).values({ id: 'preview_query', projectId: 'project_preview', query: 'best homes near here', createdAt: NOW }).run()
  db.insert(runs).values({ id: 'preview_run', projectId: 'project_preview', kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: null, createdAt: NOW }).run()
  db.insert(querySnapshots).values({
    id: 'preview_snapshot', runId: 'preview_run', queryId: 'preview_query', queryText: 'best homes near here', provider: 'openai', citationState: 'not-cited',
    answerMentioned: true, answerText: 'Northwind and Rival are useful choices.', citedDomains: ['rival.example'], citedUrls: null,
    captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW,
  }).run()
  db.insert(querySnapshots).values({
    id: 'preview_untracked', runId: 'preview_run', queryId: 'preview_query', queryText: 'best homes near here', provider: 'openai', citationState: 'not-cited',
    answerMentioned: false, answerText: 'Newrival is another useful choice.', citedDomains: ['newrival.example'], citedUrls: null,
    captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('POST /api/v1/projects/:name/competitor-changes/preview', () => {
  it('returns a typed before and after impact without writing an add', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'add', competitors: ['newrival.example'] },
    })
    expect(response.statusCode, response.body).toBe(200)
    const body = competitorChangePreviewResponseSchema.parse(response.json())
    expect(body.change).toBe('add')
    expect(body.plan.added).toEqual(['newrival.example'])
    expect(body.impact.before.percent).toBe(50)
    expect(body.impact.after.percent).toBeCloseTo(33.333333, 5)
    expect(body.impact.deltaPercent).toBeCloseTo(-16.666667, 5)
    expect(body.impact.restatesHistory).toBe(true)
    expect(db.select().from(competitors).all().map(row => row.domain)).toEqual(['rival.example'])
  })

  it('marks a measured apply-mode add as awaiting the automatic alias rescan', async () => {
    db.update(projects).set({ competitorAutoAliases: 'apply' }).run()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'add', competitors: ['newrival.example'] },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().impact.caveats).toContain('auto-alias-rescan-pending')
  })

  it('previews a curated alias set without an implicit write', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'aliases', domain: 'rival.example', aliases: ['Rival Co'], mode: 'set' },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().plan.aliasChanges).toEqual([{ domain: 'rival.example', before: [], after: ['Rival Co'] }])
    expect(db.select().from(competitors).get()?.aliases).toEqual([])
  })

  it('refuses an alias preview for an untracked competitor like the write route', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'aliases', domain: 'missing.example', aliases: ['Missing'], mode: 'set' },
    })
    expect(response.statusCode).toBe(404)
    expect(db.select().from(competitors).all()).toHaveLength(1)
  })

  it('keeps remove and replace previews aligned with their domain-only writes', async () => {
    const remove = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'remove', competitors: ['rival.example'] },
    })
    expect(remove.statusCode, remove.body).toBe(200)
    const removeBody = competitorChangePreviewResponseSchema.parse(remove.json())
    expect(removeBody.plan.removed).toEqual(['rival.example'])

    const replace = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/preview/competitor-changes/preview',
      payload: { change: 'replace', competitors: ['replacement.example'] },
    })
    expect(replace.statusCode, replace.body).toBe(200)
    const replaceBody = competitorChangePreviewResponseSchema.parse(replace.json())
    expect(replaceBody.plan.removed).toEqual(['rival.example'])
    expect(replaceBody.plan.added).toEqual(['replacement.example'])
  })
})
