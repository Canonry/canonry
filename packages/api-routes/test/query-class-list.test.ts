import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
} from '@canonry/canonry-db'
import {
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
} from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { HARBOR_CONTEXT, measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

/**
 * The query list is where an operator reads how each tracked query is classed.
 * These tests pin the class per portfolio kind, and that `null` is reported
 * wherever no single class exists instead of a `non-brand` default.
 */

const cleanups: Array<() => Promise<void>> = []
const NOW = '2026-09-01T12:00:00.000Z'

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-class-list-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  cleanups.push(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  return { app, db }
}

type Db = ReturnType<typeof createClient>

function seedProject(db: Db, name: string, identity: { displayName: string; canonicalDomain: string; aliases?: string[]; ownedDomains?: string[] }): string {
  const id = crypto.randomUUID()
  db.insert(projects).values({ id, name, country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW, ...identity }).run()
  return id
}

function seedQuery(db: Db, projectId: string, id: string, query: string): void {
  db.insert(queries).values({ id, projectId, query, provenance: 'test', createdAt: NOW }).run()
}

function activate(db: Db, projectId: string, schemaVersion: 1 | 2, canonicalJson: string): void {
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId, projectId, revision: 1, schemaVersion, canonicalJson, checksum: 'a'.repeat(64), createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
}

type Row = { id: string; query: string; createdAt: string; queryClass?: string | null }

async function listQueries(app: ReturnType<typeof Fastify>, project: string): Promise<Row[]> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${project}/queries` })
  expect(response.statusCode).toBe(200)
  return response.json<Row[]>()
}

const classById = (rows: Row[]) => Object.fromEntries(rows.map(row => [row.id, row.queryClass]))

describe('query list queryClass', () => {
  it('classes a simple project by its brand names, with the domain as stored', async () => {
    const { app, db } = buildApp()
    // Stored raw, as project upsert and apply store it: a full URL in mixed case.
    const projectId = seedProject(db, 'simple', {
      displayName: 'Vexlo IQ',
      aliases: ['Vexlo'],
      canonicalDomain: 'https://www.VexloIQ.example/path',
      ownedDomains: ['quartzline.example'],
    })
    seedQuery(db, projectId, 'q-name', 'is VEXLO-IQ worth it')
    seedQuery(db, projectId, 'q-owned', 'quartzline login')
    seedQuery(db, projectId, 'q-substring', 'vexlology explained')
    seedQuery(db, projectId, 'q-category', 'best widget shops near me')
    await app.ready()

    const rows = await listQueries(app, 'simple')

    // The existing fields are unchanged; the class is one more field on the row.
    expect(rows.find(row => row.id === 'q-name')).toEqual({
      id: 'q-name', query: 'is VEXLO-IQ worth it', createdAt: NOW, queryClass: 'branded',
    })
    expect(classById(rows)).toEqual({
      'q-name': 'branded',
      'q-owned': 'branded',
      'q-substring': 'non-brand',
      'q-category': 'non-brand',
    })
  })

  it('answers every /queries write with the same classed rows the list returns', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'writes', { displayName: 'Vexlo IQ', canonicalDomain: 'vexloiq.example' })
    seedQuery(db, projectId, 'q-kept', 'best widget shops near me')
    await app.ready()

    const appended = await app.inject({
      method: 'POST', url: '/api/v1/projects/writes/queries', payload: { queries: ['vexlo iq pricing', 'widget repair cost'] },
    })
    expect(appended.statusCode).toBe(200)
    const byText = (rows: Row[]) => Object.fromEntries(rows.map(row => [row.query, row.queryClass]))
    expect(byText(appended.json<Row[]>())).toEqual({
      'best widget shops near me': 'non-brand',
      'vexlo iq pricing': 'branded',
      'widget repair cost': 'non-brand',
    })
    expect(await listQueries(app, 'writes')).toEqual(appended.json<Row[]>())

    const removed = await app.inject({
      method: 'DELETE', url: '/api/v1/projects/writes/queries', payload: { queries: ['widget repair cost'] },
    })
    expect(byText(removed.json<Row[]>())).toEqual({ 'best widget shops near me': 'non-brand', 'vexlo iq pricing': 'branded' })

    const replaced = await app.inject({
      method: 'PUT', url: '/api/v1/projects/writes/queries', payload: { queries: ['is vexloiq legit'] },
    })
    expect(byText(replaced.json<Row[]>())).toEqual({ 'is vexloiq legit': 'branded' })
  })

  it('reports null for every query, never non-brand, when the project has no usable brand name', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'nameless', { displayName: '', canonicalDomain: '' })
    seedQuery(db, projectId, 'q-1', 'best widget shops near me')
    seedQuery(db, projectId, 'q-2', 'is vexlo iq worth it')
    await app.ready()

    expect(classById(await listQueries(app, 'nameless'))).toEqual({ 'q-1': null, 'q-2': null })
  })

  it('reads an advanced project from the classes its active revision stores, not from the text', async () => {
    const { app, db } = buildApp()
    // The project brand is "Northstar". Each stored class below disagrees with
    // what the text alone would say, so a text fallback cannot pass this test.
    const projectId = seedProject(db, 'advanced', { displayName: 'Northstar', canonicalDomain: 'northstar.example' })
    const planQueries = [
      { queryId: 'q-nearby', queryText: 'homes near harbor' },
      // Names the project brand; the operator classed it non-brand.
      { queryId: 'q-operator', queryText: 'northstar reviews' },
      // Names only a Property, so it is branded for that Property.
      { queryId: 'q-property', queryText: 'is harbor homes a good place to live' },
      // One query, measured for two Properties under different classes.
      { queryId: 'q-mixed', queryText: 'harbor homes floor plans' },
    ]
    const assignments = [
      { targetKey: 'harbor', queryId: 'q-nearby', queryClass: 'non-brand' as const },
      { targetKey: 'bayside', queryId: 'q-nearby', queryClass: 'non-brand' as const },
      { targetKey: 'harbor', queryId: 'q-operator', queryClass: 'non-brand' as const, classificationSource: 'operator' as const },
      { targetKey: 'harbor', queryId: 'q-property', queryClass: 'branded' as const },
      { targetKey: 'harbor', queryId: 'q-mixed', queryClass: 'branded' as const },
      { targetKey: 'bayside', queryId: 'q-mixed', queryClass: 'non-brand' as const },
    ]
    const plan = measurementPlanV2Fixture({
      querySnapshots: planQueries.map(query => ({
        ...query, provenance: { source: 'manual' as const, sourceId: null, capturedAt: NOW },
      })),
      executionNodes: planQueries.map(query => ({
        stableKey: `exec-${query.queryId}`,
        ...query,
        context: { providers: ['openai'], models: {}, location: HARBOR_CONTEXT },
        expectedSnapshots: 1,
      })),
      assignments: assignments.map(assignment => ({ ...assignment, executionNodeKey: `exec-${assignment.queryId}` })),
      usageEdges: assignments.map(({ targetKey, queryId }) => ({ executionNodeKey: `exec-${queryId}`, targetKey, queryId })),
    })
    activate(db, projectId, 2, canonicalMeasurementPlanV2Json(plan))
    for (const query of planQueries) seedQuery(db, projectId, query.queryId, query.queryText)
    // In the catalog, in no assignment: nothing is stored for it.
    seedQuery(db, projectId, 'q-unassigned', 'northstar pricing')
    await app.ready()

    expect(classById(await listQueries(app, 'advanced'))).toEqual({
      'q-nearby': 'non-brand',
      'q-operator': 'non-brand',
      'q-property': 'branded',
      'q-mixed': null,
      'q-unassigned': null,
    })
  })

  it('classes a project under a schema v1 plan from the text, and reports null under a plan that cannot be read', async () => {
    const { app, db } = buildApp()

    // Schema v1 selects queries per Target and records no class, so mention
    // share, sources and the competitor landscape class its queries from the
    // text. The list reports the same class they count the query under.
    const legacyId = seedProject(db, 'legacy', { displayName: 'Northstar', canonicalDomain: 'northstar.example' })
    seedQuery(db, legacyId, 'q-legacy', 'northstar reviews')
    seedQuery(db, legacyId, 'q-legacy-category', 'best widget shops')
    activate(db, legacyId, 1, canonicalMeasurementPlanJson(compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{ stableKey: 'harbor', label: 'Harbor Homes', urls: [{ kind: 'host', host: 'northstar.example' }], aliases: ['Harbor Homes'] }],
      groups: [],
      targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-legacy'] }],
    }, {
      canonicalDomain: 'northstar.example',
      ownedDomains: [],
      brandNames: ['Northstar'],
      trackedQueries: [{ id: 'q-legacy', query: 'northstar reviews' }],
      locations: [],
      defaultContext: null,
      expectedSnapshots: 1,
    })))

    // A stored revision that no longer decodes still owns the class, so the
    // list answers (it must not fail) and reports the class as unknown.
    const brokenId = seedProject(db, 'broken', { displayName: 'Northstar', canonicalDomain: 'northstar.example' })
    seedQuery(db, brokenId, 'q-broken', 'northstar reviews')
    activate(db, brokenId, 2, JSON.stringify({ schemaVersion: 2 }))
    await app.ready()

    expect(classById(await listQueries(app, 'legacy'))).toEqual({ 'q-legacy': 'branded', 'q-legacy-category': 'non-brand' })
    // The source list splits this project's answers by the same basis.
    const sources = await app.inject({ method: 'GET', url: '/api/v1/projects/legacy/analytics/sources?queryClass=branded' })
    expect(sources.statusCode).toBe(200)
    expect(sources.json<{ filters: { queryClassBasis: string | null } }>().filters.queryClassBasis).toBe('query-text')
    expect(classById(await listQueries(app, 'broken'))).toEqual({ 'q-broken': null })
  })
})
