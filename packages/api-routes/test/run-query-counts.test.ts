import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, measurementPlanVersions, migrate, projects, queries, querySnapshots, runs } from '@ainyc/canonry-db'
import { canonicalMeasurementPlanV2Json, CitationStates, RunKinds, RunStatuses, RunTriggers, type RunDetailDto } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-10-04T00:00:00.000Z'
const NORTH = { label: 'north', city: 'North City', country: 'US' }
const SCOPE = { groups: ['regional'], targets: [], queries: [], resolvedTargets: ['harbor', 'bayside'] }
const IDENTITY = { schemaVersion: 1 as const, providers: ['gemini', 'openai'], models: { gemini: 'frozen-gemini', openai: 'frozen-openai' }, checksum: 'a'.repeat(64), language: 'en' }
const MANIFEST = {
  schemaVersion: 1,
  expectedSlots: [
    { executionId: 'first-north', queryText: 'first query', provider: 'gemini', context: NORTH },
    { executionId: 'first-north', queryText: 'first query', provider: 'openai', context: NORTH },
    { executionId: 'second-north', queryText: 'second query', provider: 'gemini', context: NORTH },
    { executionId: 'second-north', queryText: 'second query', provider: 'openai', context: NORTH },
  ],
}

let tmpDir: string
let db: ReturnType<typeof createClient>
let app: ReturnType<typeof Fastify>

function seedProject(id: string) {
  db.insert(projects).values({ id, name: id, displayName: 'Count Company', canonicalDomain: 'count.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
}

function seedQuery(id: string, projectId = 'counts-project') {
  db.insert(queries).values({ id, projectId, query: `${id} query`, createdAt: NOW }).run()
}

function seedRun(id: string, advanced = false, projectId = 'counts-project') {
  if (advanced) {
    const plan = measurementPlanV2Fixture()
    const queryId = (value: string) => value === 'q-nearby' ? 'first' : 'second'
    const executionId = (value: string) => value === 'exec-nearby' ? 'first-north' : 'second-north'
    plan.querySnapshots = plan.querySnapshots.map(query => ({ ...query, queryId: queryId(query.queryId), queryText: `${queryId(query.queryId)} query` }))
    plan.assignments = plan.assignments.map(assignment => ({ ...assignment, queryId: queryId(assignment.queryId), executionNodeKey: executionId(assignment.executionNodeKey) }))
    plan.executionNodes = plan.executionNodes.map(node => ({ ...node, stableKey: executionId(node.stableKey), queryId: queryId(node.queryId), queryText: `${queryId(node.queryId)} query`, context: { ...node.context, location: NORTH } }))
    plan.usageEdges = plan.usageEdges.map(edge => ({ ...edge, queryId: queryId(edge.queryId), executionNodeKey: executionId(edge.executionNodeKey) }))
    db.insert(measurementPlanVersions).values({ id: 'frozen-version', projectId, revision: 1, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'b'.repeat(64), schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: NOW }).run()
  }
  db.insert(runs).values({
    id, projectId, kind: RunKinds['answer-visibility'], status: RunStatuses.partial,
    trigger: advanced ? RunTriggers.manual : RunTriggers.probe, createdAt: NOW,
    ...(advanced ? { measurementPlanVersionId: 'frozen-version', measurementManifest: MANIFEST, measurementScope: SCOPE, measurementExecutionIdentity: IDENTITY } : {}),
  }).run()
}

function seedSnapshot(input: Pick<typeof querySnapshots.$inferInsert, 'id' | 'runId' | 'queryId' | 'citationState'> & Partial<typeof querySnapshots.$inferInsert>) {
  db.insert(querySnapshots).values({ provider: 'gemini', createdAt: NOW, ...input }).run()
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-query-counts-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedProject('counts-project')
  for (const id of ['first', 'second', 'third', 'unobserved']) seedQuery(id)
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET /runs/:id observed query counts', () => {
  it('publishes optional nullable query counts with nonnegative integer fields', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(response.statusCode).toBe(200)
    const document = response.json<{
      paths: Record<string, { get?: { responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> } }>
      components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> }
    }>()
    expect(document.paths['/api/v1/runs/{id}']?.get?.responses?.['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/RunDetailDto' })
    const runDetail = document.components.schemas.RunDetailDto
    expect(runDetail.required).not.toContain('queryCounts')
    expect(runDetail.properties?.queryCounts).toMatchObject({
      type: 'object',
      nullable: true,
      required: ['totalQueries', 'citedQueries', 'mentionedQueries'],
      properties: {
        totalQueries: { type: 'integer', minimum: 0 },
        citedQueries: { type: 'integer', minimum: 0 },
        mentionedQueries: { type: 'integer', minimum: 0 },
      },
    })
  })

  it.each([false, true])('counts only the requested run and its resolved signals (Advanced=%s)', async advanced => {
    seedRun('requested', advanced)
    seedSnapshot({ id: 'first-mention', runId: 'requested', queryId: 'first', citationState: CitationStates['not-cited'], answerMentioned: null, answerText: 'Count Company is recommended.', requestedContext: NORTH, supportedContext: null })
    seedSnapshot({ id: 'first-citation', runId: 'requested', queryId: 'first', provider: 'openai', citationState: CitationStates.cited, answerMentioned: true, answerText: 'No brand appears here.', requestedContext: NORTH, supportedContext: { status: 'applied', resolved: NORTH } })
    seedSnapshot({ id: 'first-repeat', runId: 'requested', queryId: 'first', citationState: CitationStates.cited, answerMentioned: false, location: 'south' })
    seedSnapshot({ id: 'second-both', runId: 'requested', queryId: 'second', citationState: CitationStates.cited, answerMentioned: true })
    seedSnapshot({ id: 'third-neither', runId: 'requested', queryId: 'third', citationState: CitationStates['not-cited'], answerMentioned: true, answerText: 'No brand appears here.' })

    seedRun('newer')
    db.update(runs).set({ createdAt: '2026-10-05T00:00:00.000Z', trigger: RunTriggers.manual }).where(eq(runs.id, 'newer')).run()
    seedSnapshot({ id: 'newer-poison', runId: 'newer', queryId: 'unobserved', citationState: CitationStates.cited, answerMentioned: true })
    seedProject('foreign-project')
    seedQuery('foreign', 'foreign-project')
    seedRun('foreign-run', false, 'foreign-project')
    seedSnapshot({ id: 'foreign-poison', runId: 'foreign-run', queryId: 'foreign', citationState: CitationStates.cited, answerMentioned: true })

    const response = await app.inject({ method: 'GET', url: '/api/v1/runs/requested' })
    expect(response.statusCode).toBe(200)
    const body = response.json<RunDetailDto>()
    expect(body.id).toBe('requested')
    expect(body.queryCounts).toEqual({ totalQueries: 3, citedQueries: 2, mentionedQueries: 2 })
    expect(body.snapshots?.map(snapshot => snapshot.id).sort()).toEqual(['first-citation', 'first-mention', 'first-repeat', 'second-both', 'third-neither'])
    expect(body.snapshots?.find(snapshot => snapshot.id === 'first-mention')).toMatchObject({ queryId: 'first', answerMentioned: true, requestedContext: NORTH, supportedContext: null })
    expect(body.snapshots?.find(snapshot => snapshot.id === 'first-citation')).toMatchObject({ queryId: 'first', answerMentioned: false, requestedContext: NORTH, supportedContext: { status: 'applied', resolved: NORTH } })
    expect(body.snapshots?.find(snapshot => snapshot.id === 'third-neither')).toMatchObject({ queryId: 'third', answerMentioned: false })
    if (advanced) {
      expect(body).toMatchObject({ measurementPlanVersionId: 'frozen-version', measurementManifest: MANIFEST, measurementScope: SCOPE, measurementExecutionIdentity: IDENTITY })
    } else {
      expect(body.trigger).toBe(RunTriggers.probe)
      expect(body).not.toHaveProperty('measurementManifest')
    }
  })

  it('returns zero observed queries without turning frozen planned slots into observations', async () => {
    seedRun('empty', true)
    const response = await app.inject({ method: 'GET', url: '/api/v1/runs/empty' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 'empty', snapshots: [], queryCounts: { totalQueries: 0, citedQueries: 0, mentionedQueries: 0 }, measurementManifest: MANIFEST, measurementScope: SCOPE })
  })

  it('withholds the whole count when a deleted query leaves an unattributable historical answer', async () => {
    seedRun('historical')
    seedSnapshot({ id: 'retained', runId: 'historical', queryId: 'first', citationState: CitationStates.cited, answerMentioned: true })
    seedSnapshot({ id: 'orphan', runId: 'historical', queryId: 'second', queryText: 'first query', citationState: CitationStates.cited, answerMentioned: true })
    db.delete(queries).where(eq(queries.id, 'second')).run()

    const response = await app.inject({ method: 'GET', url: '/api/v1/runs/historical' })
    expect(response.statusCode).toBe(200)
    const body = response.json<RunDetailDto>()
    expect(body.queryCounts).toBeNull()
    expect(body.snapshots?.map(snapshot => ({ id: snapshot.id, queryId: snapshot.queryId, answerMentioned: snapshot.answerMentioned })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'orphan', queryId: null, answerMentioned: true },
      { id: 'retained', queryId: 'first', answerMentioned: true },
    ])
  })
})
