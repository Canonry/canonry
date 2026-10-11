import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiKeys, auditLog, competitors, createClient, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { selectLandscapePopulation } from '../src/competitor-landscape.js'

const NOW = '2026-08-20T12:00:00.000Z'
let tempDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-competitor-suggestions-'))
  db = createClient(path.join(tempDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'project_demo', name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example', ownedDomains: [],
    country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(queries).values({ id: 'query_demo', projectId: 'project_demo', query: 'best options', createdAt: NOW }).run()
  db.insert(runs).values([
    { id: 'run_complete', projectId: 'project_demo', kind: 'answer-visibility', status: 'completed', trigger: 'manual', location: null, createdAt: NOW },
    { id: 'run_probe', projectId: 'project_demo', kind: 'answer-visibility', status: 'completed', trigger: 'probe', location: null, createdAt: NOW },
    { id: 'run_partial', projectId: 'project_demo', kind: 'answer-visibility', status: 'partial', trigger: 'manual', location: null, createdAt: NOW },
    { id: 'run_failed', projectId: 'project_demo', kind: 'answer-visibility', status: 'failed', trigger: 'manual', location: null, createdAt: NOW },
  ]).run()
  db.insert(querySnapshots).values([
    ...['a', 'b', 'c'].map((suffix, index) => ({
      id: `snapshot_${suffix}`, runId: 'run_complete', queryId: 'query_demo', provider: 'openai', citationState: 'not-cited',
      answerMentioned: false, answerText: `Rival House is a useful choice ${index}.`, citedDomains: ['rival.example'], citedUrls: [`https://rival.example/page-${suffix}`],
      captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW,
    })),
    { id: 'snapshot_probe', runId: 'run_probe', queryId: 'query_demo', provider: 'openai', citationState: 'not-cited', answerMentioned: false, answerText: 'Rival House probe', citedDomains: ['rival.example'], citedUrls: null, captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW },
    { id: 'snapshot_partial', runId: 'run_partial', queryId: 'query_demo', provider: 'openai', citationState: 'not-cited', answerMentioned: false, answerText: 'Rival House partial', citedDomains: ['rival.example'], citedUrls: null, captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW },
    { id: 'snapshot_failed', runId: 'run_failed', queryId: 'query_demo', provider: 'openai', citationState: 'not-cited', answerMentioned: false, answerText: 'Rival House failed', citedDomains: ['rival.example'], citedUrls: null, captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW },
  ]).run()
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('GET competitor suggestions', () => {
  it('normalizes bare day windows and rejects unsupported windows with allowed choices', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/competitor-suggestions?window=90' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().window).toBe('90d')
    const rejected = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/competitor-suggestions?window=60' })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error.message).toContain('7d, 30d, 90d, all')
  })

  it('uses the canonical matcher and excludes probe and non-completed evidence', async () => {
    const before = { competitors: db.select().from(competitors).all().length, audit: db.select().from(auditLog).all().length }
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/competitor-suggestions?window=all&minAnswers=2' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.candidates, JSON.stringify(body)).toBeDefined()
    expect(body.filters).toMatchObject({ queryClass: 'non-brand', minAnswers: 2, limit: 25 })
    expect(body.candidates[0]).toMatchObject({
      domain: 'rival.example', namingAnswers: 4, citingAnswers: 4, bothAnswers: 4, pairedAnswers: 4,
    })
    expect(body.candidates[0].names[0]).toMatchObject({ name: 'Rival', answerCount: 4, pairedAnswers: 4 })
    expect(body.evidence).toMatchObject({ answeredResults: 4, sourceResults: 4, excludedProbeResults: 1, excludedNonCompletedResults: 1 })
    expect(body.runIds).toEqual(['run_complete', 'run_partial'])
    expect({ competitors: db.select().from(competitors).all().length, audit: db.select().from(auditLog).all().length }).toEqual(before)
  })

  it('falls back to pooled query classes when the project has no brand identity', async () => {
    db.update(projects).set({ displayName: '', canonicalDomain: '' }).where(eq(projects.id, 'project_demo')).run()
    const pooled = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/competitor-suggestions?window=all' })
    expect(pooled.statusCode).toBe(200)
    expect(pooled.json().filters.queryClass).toBe('all')
    const explicit = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/competitor-suggestions?queryClass=branded' })
    expect(explicit.statusCode).toBe(400)
  })

  it('ranks suggestions before exclusions when the result is limited', async () => {
    db.insert(querySnapshots).values([
      { id: 'snapshot_other_a', runId: 'run_complete', queryId: 'query_demo', provider: 'openai', citationState: 'not-cited', answerMentioned: false, answerText: 'A source list only.', citedDomains: ['other.example'], citedUrls: null, captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW },
      { id: 'snapshot_other_b', runId: 'run_partial', queryId: 'query_demo', provider: 'openai', citationState: 'not-cited', answerMentioned: false, answerText: 'A source list only.', citedDomains: ['other.example'], citedUrls: null, captureStatus: 'complete', competitorOverlap: [], location: null, createdAt: NOW },
    ]).run()
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/competitor-suggestions?window=all&minAnswers=4&limit=1' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.candidatesTotal).toBeGreaterThan(1)
    expect(body.candidates[0]).toMatchObject({ domain: 'rival.example', status: 'suggested' })
    expect(body.truncated).toBe(true)
    expect(body.excludedCounts['not-named']).toBeGreaterThan(0)
  })

  it('allows a read-only key on its project and refuses a foreign project', async () => {
    const key = 'cnry_suggestions_reader'
    db.insert(projects).values({
      id: 'project_foreign', name: 'foreign', displayName: 'Foreign', canonicalDomain: 'foreign.example', ownedDomains: [],
      country: 'US', language: 'en', providers: ['openai'], locations: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    db.insert(apiKeys).values({
      id: 'suggestions-reader', name: 'Suggestions reader', keyHash: hashApiKey(key), keyPrefix: key.slice(0, 9),
      scopes: ['read'], projectId: 'project_demo', createdAt: NOW,
    }).run()
    await app.close()
    app = Fastify()
    app.register(apiRoutes, { db })
    await app.ready()
    const headers = { authorization: `Bearer ${key}` }
    const own = await app.inject({ method: 'GET', headers, url: '/api/v1/projects/demo/competitor-suggestions?window=all' })
    expect(own.statusCode, own.body).toBe(200)
    const foreign = await app.inject({ method: 'GET', headers, url: '/api/v1/projects/foreign/competitor-suggestions?window=all' })
    expect(foreign.statusCode, foreign.body).toBe(403)
  })

  it('keeps minAnswers=4 metrics byte-equivalent when a bare competitor is tracked', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/competitor-suggestions?window=all&minAnswers=4' })
    expect(before.statusCode, before.body).toBe(200)
    const beforeCandidate = before.json().candidates.find((candidate: { domain: string }) => candidate.domain === 'rival.example')
    expect(beforeCandidate).toMatchObject({ namingAnswers: 4, citingAnswers: 4, bothAnswers: 4, pairedAnswers: 4 })
    db.insert(competitors).values({ id: 'bare-rival', projectId: 'project_demo', domain: 'rival.example', aliases: [], provenance: 'manual', createdAt: NOW }).run()
    const after = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/competitor-suggestions?window=all&minAnswers=4' })
    expect(after.statusCode, after.body).toBe(200)
    const afterCandidate = after.json().candidates.find((candidate: { domain: string }) => candidate.domain === 'rival.example')
    const comparable = (candidate: Record<string, unknown>) => {
      const { tracked: _tracked, status: _status, ...metrics } = candidate
      return metrics
    }
    expect(comparable(afterCandidate)).toEqual(comparable(beforeCandidate))
    expect(afterCandidate.tracked).toBe(true)
    const landscape = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/analytics/competitors?window=all&queryClass=non-brand' })
    expect(landscape.statusCode, landscape.body).toBe(200)
    expect(landscape.json().pinned.find((row: { domain: string }) => row.domain === 'rival.example').mentionCount).toBe(beforeCandidate.namingAnswers)
  })

  it('refuses an exact suggestion read above the answer-text cap with narrowing guidance', async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) => ({
      id: `snapshot_cap_${index}`,
      runId: 'run_complete',
      queryId: 'query_demo',
      provider: 'openai',
      citationState: 'not-cited' as const,
      answerMentioned: false,
      answerText: 'Rival House is a useful choice.',
      rawResponse: 'raw provider response must not be hydrated for the refused read',
      citedDomains: ['rival.example'],
      citedUrls: null,
      captureStatus: 'complete' as const,
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    }))
    for (let offset = 0; offset < rows.length; offset += 500) db.insert(querySnapshots).values(rows.slice(offset, offset + 500)).run()

    const prepareSpy = vi.spyOn(db.$client, 'prepare')
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/projects/demo/competitor-suggestions?window=all&minAnswers=2' })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
          details: {
            reason: 'competitor-suggestions-answer-cap',
            eligibleAnswers: 10_005,
            maxAnswers: 10_000,
            window: 'all',
            groupKey: null,
          },
        },
      })
      expect(response.body).not.toContain('raw provider response')
      const snapshotReads = prepareSpy.mock.calls
        .map(([sql]) => sql)
        .filter(sql => /from\s+["`]query_snapshots["`]/i.test(sql))
      expect(snapshotReads.length).toBeGreaterThan(0)
      expect(snapshotReads.every(sql => !/["`]query_snapshots["`]\s*\.\s*["`]answer_text["`]/i.test(sql))).toBe(true)
      expect(snapshotReads.every(sql => !/["`]query_snapshots["`]\s*\.\s*["`]raw_response["`]/i.test(sql))).toBe(true)
    } finally {
      prepareSpy.mockRestore()
    }
  })

  it('hydrates only eligible rows after filtering and preserves exact within-cap counts', () => {
    const population = selectLandscapePopulation({ db }, 'demo', { window: 'all', queryClass: 'all' }, {
      runIds: ['run_complete', 'run_probe', 'run_partial', 'run_failed'],
      answerTextCap: 4,
    })
    expect(population.eligibleSnapshots).toHaveLength(4)
    expect(population.excludedProbeResults).toBe(1)
    expect(population.excludedNonCompletedResults).toBe(1)
    expect(population.eligibleSnapshots.every(snapshot => snapshot.answerText !== null)).toBe(true)
    expect(population.inScope.filter(snapshot => snapshot.runId === 'run_probe' || snapshot.runId === 'run_failed').every(snapshot => snapshot.answerText === null)).toBe(true)
    expect(population.eligibleSnapshots.every(snapshot => snapshot.rawResponse === null)).toBe(true)
  })
})
