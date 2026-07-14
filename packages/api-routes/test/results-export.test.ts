import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

interface ResultExportResponse {
  schemaVersion: string
  generatedAt: string
  project: { id: string; name: string; displayName: string; canonicalDomain: string }
  filters: { since: string | null; until: string | null; includeProbes: boolean }
  recordCount: number
  records: Array<{
    runId: string
    runStatus: string
    runTrigger: string
    queryId: string | null
    query: string | null
    citationState: string
    cited: boolean
    answerMentioned: boolean | null
    mentionState: string | null
    answerText: string | null
    groundingSources: Array<{ uri: string; title: string }>
    searchQueries: string[]
  }>
}

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: DatabaseClient
  tmpDir: string
  projectId: string
  runIds: { completed: string; partial: string; archived: string; probe: string }
}

function insertRun(
  db: DatabaseClient,
  projectId: string,
  values: { createdAt: string; status?: 'completed' | 'partial' | 'failed'; trigger?: 'manual' | 'probe'; kind?: 'answer-visibility' | 'site-audit' },
): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: values.kind ?? 'answer-visibility',
    status: values.status ?? 'completed',
    trigger: values.trigger ?? 'manual',
    createdAt: values.createdAt,
    startedAt: values.createdAt,
    finishedAt: values.createdAt,
  }).run()
  return id
}

function buildCtx(): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-results-export-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'acme',
    displayName: 'Acme, Inc.',
    canonicalDomain: 'acme.example',
    country: 'US',
    language: 'en',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  }).run()

  const queryId = crypto.randomUUID()
  db.insert(queries).values({
    id: queryId,
    projectId,
    query: '=SUM(1,1)',
    createdAt: '2026-07-01T00:00:00.000Z',
  }).run()

  const completed = insertRun(db, projectId, { createdAt: '2026-07-01T12:00:00.000Z' })
  const partial = insertRun(db, projectId, { createdAt: '2026-07-02T12:00:00.000Z', status: 'partial' })
  const archived = insertRun(db, projectId, { createdAt: '2026-07-02T13:00:00.000Z', status: 'failed' })
  const probe = insertRun(db, projectId, { createdAt: '2026-07-03T12:00:00.000Z', trigger: 'probe' })
  const siteAudit = insertRun(db, projectId, { createdAt: '2026-07-04T12:00:00.000Z', kind: 'site-audit' })

  db.insert(querySnapshots).values([
    {
      id: crypto.randomUUID(),
      runId: completed,
      queryId,
      queryText: '=SUM(1,1)',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      citationState: 'cited',
      answerMentioned: true,
      answerText: 'Acme, Inc. is a cited answer.',
      citedDomains: ['acme.example'],
      competitorOverlap: ['rival.example'],
      recommendedCompetitors: ['new-rival.example'],
      location: 'new-york',
      rawResponse: JSON.stringify({
        groundingSources: [{ uri: 'https://acme.example/guide', title: 'Acme guide' }],
        searchQueries: ['acme guide'],
        apiResponse: { privateProviderField: 'must not export' },
      }),
      createdAt: '2026-07-01T12:01:00.000Z',
    },
    {
      id: crypto.randomUUID(),
      runId: partial,
      queryId,
      queryText: '=SUM(1,1)',
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: null,
      answerText: null,
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: null,
      rawResponse: null,
      createdAt: '2026-07-02T12:01:00.000Z',
    },
    {
      id: crypto.randomUUID(),
      runId: archived,
      queryId: null,
      queryText: 'archived query',
      provider: 'claude',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Archived query evidence.',
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: null,
      rawResponse: JSON.stringify({ searchQueries: ['archived query'] }),
      createdAt: '2026-07-02T13:01:00.000Z',
    },
    {
      id: crypto.randomUUID(),
      runId: probe,
      queryId,
      queryText: '=SUM(1,1)',
      provider: 'gemini',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Probe result must be excluded by default.',
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: null,
      rawResponse: null,
      createdAt: '2026-07-03T12:01:00.000Z',
    },
    {
      id: crypto.randomUUID(),
      runId: siteAudit,
      queryId,
      queryText: '=SUM(1,1)',
      provider: 'gemini',
      citationState: 'cited',
      answerMentioned: true,
      answerText: 'A non-answer-visibility run must not be exported.',
      citedDomains: ['acme.example'],
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: null,
      rawResponse: null,
      createdAt: '2026-07-04T12:01:00.000Z',
    },
  ]).run()

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  return { app, db, tmpDir, projectId, runIds: { completed, partial, archived, probe } }
}

let ctx: Ctx

beforeEach(async () => {
  ctx = buildCtx()
  await ctx.app.ready()
})

afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

describe('GET /api/v1/projects/:name/results/export', () => {
  it('downloads historical non-probe answer-engine observations as versioned JSON', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/acme/results/export' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="canonry-results-acme-\d{4}-\d{2}-\d{2}\.json"/)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')

    const body = res.json() as ResultExportResponse
    expect(body.schemaVersion).toBe('canonry.results-export/v1')
    expect(body.project).toMatchObject({ id: ctx.projectId, name: 'acme', displayName: 'Acme, Inc.', canonicalDomain: 'acme.example' })
    expect(body.filters).toEqual({ since: null, until: null, includeProbes: false })
    expect(body.recordCount).toBe(3)
    expect(body.records.map(record => record.runId)).toEqual([
      ctx.runIds.completed,
      ctx.runIds.partial,
      ctx.runIds.archived,
    ])
    expect(body.records[0]).toMatchObject({
      query: '=SUM(1,1)',
      citationState: 'cited',
      cited: true,
      answerMentioned: true,
      mentionState: 'mentioned',
      answerText: 'Acme, Inc. is a cited answer.',
      groundingSources: [{ uri: 'https://acme.example/guide', title: 'Acme guide' }],
      searchQueries: ['acme guide'],
    })
    expect(body.records[1]).toMatchObject({
      runStatus: 'partial',
      answerMentioned: null,
      mentionState: null,
    })
    expect(body.records[2]).toMatchObject({
      runStatus: 'failed',
      queryId: null,
      query: 'archived query',
      answerMentioned: false,
      mentionState: 'not-mentioned',
    })
    expect(res.body).not.toContain('privateProviderField')
  })

  it('honors inclusive date filters and only includes probes when explicitly requested', async () => {
    const dated = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/acme/results/export?since=2026-07-02&until=2026-07-02',
    })
    const datedBody = dated.json() as ResultExportResponse
    expect(datedBody.records.map(record => record.runId)).toEqual([ctx.runIds.partial, ctx.runIds.archived])
    expect(datedBody.filters).toEqual({ since: '2026-07-02', until: '2026-07-02', includeProbes: false })

    const includingProbes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects/acme/results/export?includeProbes=true',
    })
    const probeBody = includingProbes.json() as ResultExportResponse
    expect(probeBody.records.map(record => record.runId)).toEqual([
      ctx.runIds.completed,
      ctx.runIds.partial,
      ctx.runIds.archived,
      ctx.runIds.probe,
    ])
  })

  it('serializes the same records as spreadsheet-safe CSV', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/acme/results/export?format=csv' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toMatch(/\.csv"/)
    expect(res.body).toContain('export_schema_version,project_id,project_name,project_display_name,canonical_domain')
    expect(res.body).toContain("'=SUM(1,1)")
    expect(res.body).not.toContain('privateProviderField')
  })

  it('exports a snapshot whose stored rawResponse is corrupt (non-JSON) with empty evidence instead of failing', async () => {
    // The endpoint's job is exporting history AS STORED — a legacy row with a
    // mangled rawResponse must degrade to empty grounding evidence, never 500.
    const corruptRun = insertRun(ctx.db, ctx.projectId, { createdAt: '2026-07-05T12:00:00.000Z' })
    ctx.db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId: corruptRun,
      queryId: null,
      queryText: 'corrupt evidence query',
      provider: 'gemini',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Row with unparseable rawResponse.',
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      location: null,
      rawResponse: 'not-json{{{',
      createdAt: '2026-07-05T12:01:00.000Z',
    }).run()

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/acme/results/export' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as ResultExportResponse
    const corrupt = body.records.find(record => record.query === 'corrupt evidence query')
    expect(corrupt).toMatchObject({
      runId: corruptRun,
      answerText: 'Row with unparseable rawResponse.',
      groundingSources: [],
      searchQueries: [],
    })
  })

  it('rejects invalid export filters', async () => {
    const invalidDate = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/acme/results/export?since=not-a-date' })
    expect(invalidDate.statusCode).toBe(400)

    const backwards = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/acme/results/export?since=2026-07-03&until=2026-07-02' })
    expect(backwards.statusCode).toBe(400)

    const invalidFormat = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/acme/results/export?format=yaml' })
    expect(invalidFormat.statusCode).toBe(400)
  })
})
