import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate, projects, keywords, querySnapshots, runs } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts })

  return { app, db, tmpDir, dbPath }
}

describe('api-routes', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('PUT /api/v1/projects/:name creates a project', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'My Site',
        canonicalDomain: 'example.com',
        ownedDomains: ['docs.example.com'],
        country: 'US',
        language: 'en',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.name).toBe('my-site')
    expect(body.displayName).toBe('My Site')
    expect(body.canonicalDomain).toBe('example.com')
    expect(body.ownedDomains).toEqual(['docs.example.com'])
  })

  it('PUT /api/v1/projects/:name rejects an unknown defaultLocation', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/bad-default',
      payload: {
        displayName: 'Bad Default',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
        locations: [
          { label: 'nyc', city: 'New York', region: 'NY', country: 'US' },
        ],
        defaultLocation: 'sf',
      },
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/defaultLocation/)
  })

  it('GET /api/v1/projects lists projects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toBeInstanceOf(Array)
    expect(body).toHaveLength(1)
    expect(body[0].name).toBe('my-site')
    expect(body[0].ownedDomains).toEqual(['docs.example.com'])
  })

  it('GET /api/v1/openapi.json returns the API spec', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type'] ?? '').toMatch(/application\/json/)

    const body = JSON.parse(res.payload) as {
      openapi: string
      paths: Record<string, Record<string, { security?: unknown[] }>>
    }

    expect(body.openapi).toBe('3.1.0')
    expect(body.paths['/api/v1/openapi.json']).toBeDefined()
    expect(body.paths['/api/v1/projects']).toBeDefined()
    expect(body.paths['/api/v1/openapi.json']?.get?.security).toEqual([])
  })

  it('GET /api/v1/projects/:name gets a single project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.name).toBe('my-site')
    expect(body.ownedDomains).toEqual(['docs.example.com'])
  })

  it('GET /api/v1/projects/:name returns 404 for unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('PUT /api/v1/projects/:name/keywords sets keywords', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: ['aeo tools', 'answer engine'] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toHaveLength(2)
  })

  it('DELETE /api/v1/projects/:name/keywords removes specific keywords', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: ['aeo tools'] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toHaveLength(1)
    expect(body[0].keyword).toBe('answer engine')
  })

  it('DELETE /api/v1/projects/:name/keywords ignores non-existent keywords', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: ['does not exist'] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toHaveLength(1)
  })

  it('DELETE /api/v1/projects/:name/keywords rejects empty array', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  // Re-add keywords for subsequent tests
  it('POST /api/v1/projects/:name/keywords re-adds keywords', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/keywords',
      payload: { keywords: ['aeo tools'] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toHaveLength(2)
  })

  it('POST /api/v1/projects/:name/keywords/generate returns provider suggestions', async () => {
    const ctx = buildApp({
      validProviderNames: ['gemini'],
      onGenerateKeywords: async (provider, count, project) => {
        expect(provider).toBe('gemini')
        expect(count).toBe(3)
        expect(project.domain).toBe('example.com')
        return ['answer visibility software', 'ai citation tracking']
      },
    })
    try {
      await ctx.app.ready()
      await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/projects/generator',
        payload: {
          displayName: 'Generator',
          canonicalDomain: 'example.com',
          country: 'US',
          language: 'en',
        },
      })

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/projects/generator/keywords/generate',
        payload: { provider: 'gemini', count: 3 },
      })

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.payload)).toEqual({
        provider: 'gemini',
        keywords: ['answer visibility software', 'ai citation tracking'],
      })
    } finally {
      await ctx.app.close()
      fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    }
  })

  it('POST /api/v1/projects/:name/competitors appends competitors idempotently', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/competitor-append',
      payload: {
        displayName: 'Competitor Append',
        canonicalDomain: 'append.example.com',
        country: 'US',
        language: 'en',
      },
    })

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/competitor-append/competitors',
      payload: { competitors: ['rival.com', 'rival.com'] },
    })
    expect(first.statusCode).toBe(200)
    expect(JSON.parse(first.payload).map((row: { domain: string }) => row.domain)).toEqual(['rival.com'])

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/competitor-append/competitors',
      payload: { competitors: ['rival.com', 'other-rival.com'] },
    })
    expect(second.statusCode).toBe(200)
    expect(JSON.parse(second.payload).map((row: { domain: string }) => row.domain).sort()).toEqual([
      'other-rival.com',
      'rival.com',
    ])
  })

  it('POST /api/v1/projects/:name/competitors strips subdomains and dedupes', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/competitor-normalize',
      payload: {
        displayName: 'Competitor Normalize',
        canonicalDomain: 'normalize.example.com',
        country: 'US',
        language: 'en',
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/competitor-normalize/competitors',
      payload: {
        competitors: [
          'offers.roofle.com',
          'https://www.Roofle.com/pricing',
          'app.acme.io',
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).map((row: { domain: string }) => row.domain).sort()).toEqual([
      'acme.io',
      'roofle.com',
    ])
  })

  it('DELETE /api/v1/projects/:name/competitors normalizes the request before matching', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/competitor-delete-normalized',
      payload: {
        displayName: 'Competitor Delete Normalized',
        canonicalDomain: 'delete-normalized.example.com',
        country: 'US',
        language: 'en',
      },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/competitor-delete-normalized/competitors',
      payload: { competitors: ['offers.roofle.com'] },
    })

    // Caller passes the original subdomain form; server normalizes and finds
    // the stored `roofle.com` row.
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/competitor-delete-normalized/competitors',
      payload: { competitors: ['offers.roofle.com'] },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual([])
  })

  it('DELETE /api/v1/projects/:name/competitors removes specific competitors', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/competitor-delete',
      payload: {
        displayName: 'Competitor Delete',
        canonicalDomain: 'delete.example.com',
        country: 'US',
        language: 'en',
      },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/competitor-delete/competitors',
      payload: { competitors: ['rival.com', 'other-rival.com'] },
    })

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/competitor-delete/competitors',
      payload: { competitors: ['rival.com', 'missing-rival.com'] },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).map((row: { domain: string }) => row.domain)).toEqual(['other-rival.com'])
  })

  it('POST /api/v1/projects/:name/runs triggers a run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/runs',
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.status).toBe('queued')
    expect(body.kind).toBe('answer-visibility')
  })

  it('POST /api/v1/projects/:name/runs rejects duplicate active run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/runs',
      payload: {},
    })
    expect(res.statusCode).toBe(409)
  })

  it('POST /api/v1/projects/:name/runs rejects non-manual trigger metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/runs',
      payload: { trigger: 'scheduled' },
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe('Invalid run trigger request')
  })

  it('GET /api/v1/projects/:name/runs respects the limit query', async () => {
    const project = db.select().from(projects).all().find(row => row.name === 'my-site')
    expect(project).toBeDefined()

    const olderRunId = crypto.randomUUID()
    const latestRunId = crypto.randomUUID()
    const olderCreatedAt = new Date(Date.now() + 10_000).toISOString()
    const latestCreatedAt = new Date(Date.now() + 20_000).toISOString()

    db.insert(runs).values([
      {
        id: olderRunId,
        projectId: project!.id,
        status: 'completed',
        createdAt: olderCreatedAt,
        finishedAt: olderCreatedAt,
      },
      {
        id: latestRunId,
        projectId: project!.id,
        status: 'completed',
        createdAt: latestCreatedAt,
        finishedAt: latestCreatedAt,
      },
    ]).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/runs?limit=2' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{ id: string }>
    expect(body.map(run => run.id)).toEqual([olderRunId, latestRunId])
  })

  it('PUT /api/v1/projects/:name/schedule accepts any provider name string (validated at runtime)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site/schedule',
      payload: {
        preset: 'daily',
        providers: ['bogus-provider'],
      },
    })

    // Provider names are now validated at runtime against registered adapters,
    // not at schema level, so this should succeed
    expect(res.statusCode).toBe(201)
  })

  it('GET /api/v1/projects/:name/history returns audit log', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/history' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toBeInstanceOf(Array)
    expect(body.length).toBeGreaterThan(0)
  })

  it('run detail and project snapshot history expose recommendedCompetitors', async () => {
    const projectId = crypto.randomUUID()
    const keywordId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const now = new Date(Date.now() + 30_000).toISOString()

    db.insert(projects).values({
      id: projectId,
      name: 'snapshot-history-project',
      displayName: 'Snapshot History Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      providers: '[]',
      createdAt: now,
      updatedAt: now,
    }).run()

    db.insert(keywords).values({
      id: keywordId,
      projectId,
      keyword: 'best example software',
      createdAt: now,
    }).run()

    db.insert(runs).values({
      id: runId,
      projectId,
      status: 'completed',
      createdAt: now,
      finishedAt: now,
    }).run()

    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId,
      keywordId,
      provider: 'gemini',
      citationState: 'not-cited',
      answerText: '1. Downtown Smiles - strong reviews',
      citedDomains: '["downtownsmiles.com"]',
      competitorOverlap: '["downtownsmiles.com"]',
      recommendedCompetitors: '["Downtown Smiles"]',
      rawResponse: '{"groundingSources":[],"searchQueries":[]}',
      createdAt: now,
    }).run()

    const runRes = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })
    expect(runRes.statusCode).toBe(200)
    const runBody = JSON.parse(runRes.payload) as {
      snapshots: Array<{
        recommendedCompetitors: string[]
        answerMentioned?: boolean
        visibilityState?: string
      }>
    }
    expect(runBody.snapshots[0]?.recommendedCompetitors).toEqual(['Downtown Smiles'])
    expect(runBody.snapshots[0]?.answerMentioned).toBe(false)
    expect(runBody.snapshots[0]?.visibilityState).toBe('not-visible')

    const historyRes = await app.inject({ method: 'GET', url: '/api/v1/projects/snapshot-history-project/snapshots' })
    expect(historyRes.statusCode).toBe(200)
    const historyBody = JSON.parse(historyRes.payload) as {
      snapshots: Array<{
        recommendedCompetitors: string[]
        answerMentioned?: boolean
        visibilityState?: string
      }>
    }
    expect(historyBody.snapshots[0]?.recommendedCompetitors).toEqual(['Downtown Smiles'])
    expect(historyBody.snapshots[0]?.answerMentioned).toBe(false)
    expect(historyBody.snapshots[0]?.visibilityState).toBe('not-visible')
  })

  it('project timeline exposes answer visibility states and transitions', async () => {
    const projectId = crypto.randomUUID()
    const keywordId = crypto.randomUUID()
    const run1Id = crypto.randomUUID()
    const run2Id = crypto.randomUUID()
    const run1At = new Date(Date.now() + 40_000).toISOString()
    const run2At = new Date(Date.now() + 50_000).toISOString()

    db.insert(projects).values({
      id: projectId,
      name: 'timeline-visibility-project',
      displayName: 'Timeline Visibility Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      providers: '[]',
      createdAt: run1At,
      updatedAt: run1At,
    }).run()

    db.insert(keywords).values({
      id: keywordId,
      projectId,
      keyword: 'best example tooling',
      createdAt: run1At,
    }).run()

    db.insert(runs).values([
      {
        id: run1Id,
        projectId,
        status: 'completed',
        createdAt: run1At,
        finishedAt: run1At,
      },
      {
        id: run2Id,
        projectId,
        status: 'completed',
        createdAt: run2At,
        finishedAt: run2At,
      },
    ]).run()

    db.insert(querySnapshots).values([
      {
        id: crypto.randomUUID(),
        runId: run1Id,
        keywordId,
        provider: 'gemini',
        citationState: 'not-cited',
        answerMentioned: false,
        answerText: 'Here are several vendors to consider.',
        citedDomains: '[]',
        competitorOverlap: '[]',
        recommendedCompetitors: '[]',
        rawResponse: '{"groundingSources":[],"searchQueries":[]}',
        createdAt: run1At,
      },
      {
        id: crypto.randomUUID(),
        runId: run2Id,
        keywordId,
        provider: 'gemini',
        citationState: 'not-cited',
        answerMentioned: true,
        answerText: 'Example.com is one of the vendors to consider.',
        citedDomains: '["example.com"]',
        competitorOverlap: '[]',
        recommendedCompetitors: '[]',
        rawResponse: '{"groundingSources":[],"searchQueries":[]}',
        createdAt: run2At,
      },
    ]).run()

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/timeline-visibility-project/timeline' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as Array<{
      runs: Array<{
        answerMentioned?: boolean
        visibilityState?: string
        visibilityTransition?: string
      }>
      providerRuns?: Record<string, Array<{
        answerMentioned?: boolean
        visibilityState?: string
        visibilityTransition?: string
      }>>
    }>

    expect(body[0]?.runs).toEqual([
      expect.objectContaining({
        answerMentioned: false,
        visibilityState: 'not-visible',
        visibilityTransition: 'new',
      }),
      expect.objectContaining({
        answerMentioned: true,
        visibilityState: 'visible',
        visibilityTransition: 'emerging',
      }),
    ])
    expect(body[0]?.providerRuns?.gemini?.[1]).toEqual(expect.objectContaining({
      answerMentioned: true,
      visibilityState: 'visible',
      visibilityTransition: 'emerging',
    }))
  })

  it('GET /api/v1/projects/:name/snapshots/diff includes visibility comparison fields', async () => {
    const projectId = crypto.randomUUID()
    const keywordId = crypto.randomUUID()
    const run1Id = crypto.randomUUID()
    const run2Id = crypto.randomUUID()
    const run1At = new Date('2025-02-01T10:00:00.000Z').toISOString()
    const run2At = new Date('2025-02-02T10:00:00.000Z').toISOString()

    db.insert(projects).values({
      id: projectId,
      name: 'diff-visibility-project',
      displayName: 'Example',
      canonicalDomain: 'example.com',
      ownedDomains: '[]',
      country: 'US',
      language: 'en',
      providers: '[]',
      createdAt: run1At,
      updatedAt: run1At,
    }).run()

    db.insert(keywords).values({
      id: keywordId,
      projectId,
      keyword: 'best example tooling',
      createdAt: run1At,
    }).run()

    db.insert(runs).values([
      {
        id: run1Id,
        projectId,
        status: 'completed',
        createdAt: run1At,
        finishedAt: run1At,
      },
      {
        id: run2Id,
        projectId,
        status: 'completed',
        createdAt: run2At,
        finishedAt: run2At,
      },
    ]).run()

    db.insert(querySnapshots).values([
      {
        id: crypto.randomUUID(),
        runId: run1Id,
        keywordId,
        provider: 'gemini',
        citationState: 'not-cited',
        answerMentioned: false,
        answerText: 'Here are several vendors to consider.',
        citedDomains: '[]',
        competitorOverlap: '[]',
        recommendedCompetitors: '[]',
        rawResponse: '{"groundingSources":[],"searchQueries":[]}',
        createdAt: run1At,
      },
      {
        id: crypto.randomUUID(),
        runId: run2Id,
        keywordId,
        provider: 'gemini',
        citationState: 'not-cited',
        answerMentioned: true,
        answerText: 'Example.com is one of the vendors to consider.',
        citedDomains: '[]',
        competitorOverlap: '[]',
        recommendedCompetitors: '[]',
        rawResponse: '{"groundingSources":[],"searchQueries":[]}',
        createdAt: run2At,
      },
    ]).run()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/diff-visibility-project/snapshots/diff?run1=${run1Id}&run2=${run2Id}`,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload) as {
      diff: Array<{
        run1State: string | null
        run2State: string | null
        run1AnswerMentioned: boolean | null
        run2AnswerMentioned: boolean | null
        run1VisibilityState: string | null
        run2VisibilityState: string | null
        changed: boolean
        visibilityChanged: boolean
      }>
    }

    expect(body.diff).toEqual([
      expect.objectContaining({
        run1State: 'not-cited',
        run2State: 'not-cited',
        run1AnswerMentioned: false,
        run2AnswerMentioned: true,
        run1VisibilityState: 'not-visible',
        run2VisibilityState: 'visible',
        changed: false,
        visibilityChanged: true,
      }),
    ])
  })

  it('PUT /api/v1/projects/:name updates project settings', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'Updated Site',
        canonicalDomain: 'updated.com',
        ownedDomains: ['docs.updated.com', 'blog.updated.com'],
        country: 'GB',
        language: 'en-gb',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.name).toBe('my-site')
    expect(body.displayName).toBe('Updated Site')
    expect(body.canonicalDomain).toBe('updated.com')
    expect(body.ownedDomains).toEqual(['docs.updated.com', 'blog.updated.com'])
    expect(body.country).toBe('GB')
    expect(body.language).toBe('en-gb')

    // Verify GET returns updated values
    const getRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site' })
    expect(getRes.statusCode).toBe(200)
    const getBody = JSON.parse(getRes.payload)
    expect(getBody.displayName).toBe('Updated Site')
    expect(getBody.canonicalDomain).toBe('updated.com')
    expect(getBody.ownedDomains).toEqual(['docs.updated.com', 'blog.updated.com'])
    expect(getBody.country).toBe('GB')
    expect(getBody.language).toBe('en-gb')
  })

  it('PUT /api/v1/projects/:name with empty ownedDomains clears them', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'Updated Site',
        canonicalDomain: 'updated.com',
        ownedDomains: [],
        country: 'GB',
        language: 'en-gb',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.ownedDomains).toEqual([])
  })

  it('PUT /api/v1/projects/:name without ownedDomains defaults to empty', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'Updated Site',
        canonicalDomain: 'updated.com',
        country: 'GB',
        language: 'en-gb',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.ownedDomains).toEqual([])
  })

  it('PUT /api/v1/projects/:name rejects ownedDomains with empty string elements', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site',
      payload: {
        displayName: 'My Site',
        canonicalDomain: 'example.com',
        ownedDomains: ['docs.example.com', ''],
        country: 'US',
        language: 'en',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('PUT /api/v1/projects/:name preserves tags and providers when included', async () => {
    // Seed a project with tags and providers
    const createRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/metadata-test',
      payload: {
        displayName: 'Metadata Test',
        canonicalDomain: 'meta.example.com',
        country: 'US',
        language: 'en',
        tags: ['seo', 'ai'],
        providers: ['gemini', 'openai'],
      },
    })
    expect(createRes.statusCode).toBe(201)

    // Update only ownedDomains, passing tags and providers through (as the client now does)
    const updateRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/metadata-test',
      payload: {
        displayName: 'Metadata Test',
        canonicalDomain: 'meta.example.com',
        ownedDomains: ['docs.meta.example.com'],
        country: 'US',
        language: 'en',
        tags: ['seo', 'ai'],
        providers: ['gemini', 'openai'],
      },
    })
    expect(updateRes.statusCode).toBe(200)
    const body = JSON.parse(updateRes.payload)
    expect(body.ownedDomains).toEqual(['docs.meta.example.com'])
    expect(body.tags).toEqual(['seo', 'ai'])
    expect(body.providers).toEqual(['gemini', 'openai'])
  })

  // --- Location CRUD tests ---

  it('POST /api/v1/projects/:name/locations adds a location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: {
        label: 'nyc',
        city: 'New York',
        region: 'New York',
        country: 'US',
        timezone: 'America/New_York',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.payload)
    expect(body.label).toBe('nyc')
    expect(body.city).toBe('New York')
    expect(body.timezone).toBe('America/New_York')
  })

  it('POST /api/v1/projects/:name/locations rejects duplicate label', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: {
        label: 'nyc',
        city: 'New York',
        region: 'New York',
        country: 'US',
      },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/already exists/)
  })

  it('POST /api/v1/projects/:name/locations rejects invalid location data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: {
        label: 'bad',
        city: 'Berlin',
        region: 'Berlin',
        country: 'DEU', // 3 chars, should be 2
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET /api/v1/projects/:name/locations lists locations and default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/my-site/locations',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.locations).toBeInstanceOf(Array)
    expect(body.locations).toHaveLength(1)
    expect(body.locations[0].label).toBe('nyc')
    expect(body.defaultLocation).toBeNull()
  })

  it('PUT /api/v1/projects/:name/locations/default sets the default location', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site/locations/default',
      payload: { label: 'nyc' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.defaultLocation).toBe('nyc')

    // Verify via GET locations
    const getRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/locations' })
    const getBody = JSON.parse(getRes.payload)
    expect(getBody.defaultLocation).toBe('nyc')
  })

  it('PUT /api/v1/projects/:name/locations/default rejects unknown label', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site/locations/default',
      payload: { label: 'nonexistent' },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error.message).toMatch(/not found/)
  })

  it('PUT /api/v1/projects/:name/locations/default rejects missing label', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/my-site/locations/default',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/v1/projects/:name/locations adds a second location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: {
        label: 'london',
        city: 'London',
        region: 'England',
        country: 'GB',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.payload).label).toBe('london')

    // Verify both exist
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/locations' })
    const listBody = JSON.parse(listRes.payload)
    expect(listBody.locations).toHaveLength(2)
  })

  it('DELETE /api/v1/projects/:name/locations/:label removes a location', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/locations/london',
    })
    expect(res.statusCode).toBe(204)

    // Verify removed
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/locations' })
    const listBody = JSON.parse(listRes.payload)
    expect(listBody.locations).toHaveLength(1)
    expect(listBody.locations[0].label).toBe('nyc')
  })

  it('DELETE /api/v1/projects/:name/locations/:label returns 400 for unknown label', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/locations/nonexistent',
    })
    expect(res.statusCode).toBe(400)
  })

  it('DELETE /api/v1/projects/:name/locations/:label clears default when removing default location', async () => {
    // Default is currently 'nyc' — remove it
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/my-site/locations/nyc',
    })
    expect(res.statusCode).toBe(204)

    // Verify default is cleared
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site/locations' })
    const listBody = JSON.parse(listRes.payload)
    expect(listBody.locations).toHaveLength(0)
    expect(listBody.defaultLocation).toBeNull()
  })

  it('GET /api/v1/projects/:name includes locations in project response', async () => {
    // Add a location back for the project response test
    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/my-site/locations',
      payload: { label: 'sf', city: 'San Francisco', region: 'California', country: 'US' },
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/my-site' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.locations).toBeInstanceOf(Array)
    expect(body.locations).toHaveLength(1)
    expect(body.locations[0].label).toBe('sf')
  })

  it('POST /api/v1/projects/:name/locations returns 404 for unknown project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/nonexistent/locations',
      payload: { label: 'test', city: 'Test', region: 'Test', country: 'US' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/v1/settings returns provider and google summaries', async () => {
    const settingsCtx = buildApp({
      providerSummary: [{ name: 'gemini', configured: true }],
      googleSettingsSummary: { configured: false },
    })
    const settingsApp = settingsCtx.app
    await settingsApp.ready()

    try {
      const res = await settingsApp.inject({ method: 'GET', url: '/api/v1/settings' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload) as {
        providers: Array<{ name: string; configured: boolean }>
        google: { configured: boolean }
      }
      expect(body.providers).toEqual([{ name: 'gemini', configured: true }])
      expect(body.google).toEqual({ configured: false })
    } finally {
      await settingsApp.close()
      fs.rmSync(settingsCtx.tmpDir, { recursive: true, force: true })
    }
  })

  it('PUT /api/v1/settings/google updates Google OAuth config', async () => {
    let lastUpdate: { clientId: string; clientSecret: string } | null = null
    const settingsCtx = buildApp({
      googleSettingsSummary: { configured: false },
      onGoogleSettingsUpdate: (clientId, clientSecret) => {
        lastUpdate = { clientId, clientSecret }
        return { configured: true }
      },
    })
    const settingsApp = settingsCtx.app
    await settingsApp.ready()

    try {
      const res = await settingsApp.inject({
        method: 'PUT',
        url: '/api/v1/settings/google',
        payload: {
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
        },
      })
      expect(res.statusCode).toBe(200)
      expect(lastUpdate).toEqual({
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
      })
      expect(JSON.parse(res.payload)).toEqual({ configured: true })
    } finally {
      await settingsApp.close()
      fs.rmSync(settingsCtx.tmpDir, { recursive: true, force: true })
    }
  })
})
