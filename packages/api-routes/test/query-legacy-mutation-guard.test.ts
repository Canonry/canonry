import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apiKeys,
  createClient,
  measurementPlanDrafts,
  measurementPlans,
  measurementPlanVersions,
  measurementQuerySetItems,
  measurementQuerySets,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
} from '@ainyc/canonry-db'
import {
  RunStatuses,
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
} from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const cleanups: Array<() => Promise<void>> = []
const NOW = '2026-08-30T12:00:00.000Z'

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function buildApp(skipAuth = true) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-legacy-mutation-guard-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth })
  cleanups.push(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  return { app, db }
}

function seedProject(db: ReturnType<typeof createClient>, name: string, displayName = name): string {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id,
    name,
    displayName,
    canonicalDomain: `${name}.example`,
    country: 'US',
    language: 'en',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  return id
}

function seedQuery(
  db: ReturnType<typeof createClient>,
  projectId: string,
  query: string,
  id = crypto.randomUUID(),
): string {
  db.insert(queries).values({ id, projectId, query, provenance: 'test', createdAt: NOW }).run()
  return id
}

function seedSnapshot(
  db: ReturnType<typeof createClient>,
  projectId: string,
  queryId: string,
  queryText: string | null,
): string {
  const runId = crypto.randomUUID()
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: NOW,
    finishedAt: NOW,
  }).run()
  db.insert(querySnapshots).values({
    id,
    runId,
    queryId,
    queryText,
    provider: 'openai',
    citationState: 'cited',
    citedDomains: [],
    competitorOverlap: [],
    recommendedCompetitors: [],
    createdAt: NOW,
  }).run()
  return id
}

function activateV1Plan(db: ReturnType<typeof createClient>, projectId: string, assignedQueryId: string): void {
  const plan = compileMeasurementPlan({
    schemaVersion: 1,
    targets: [{
      stableKey: 'legacy-target',
      label: 'Legacy target',
      urls: [{ kind: 'host', host: 'legacy.example' }],
      aliases: ['Legacy target'],
    }],
    groups: [],
    targetQuerySelections: [{ targetKey: 'legacy-target', queryIds: [assignedQueryId] }],
  }, {
    canonicalDomain: 'legacy.example',
    ownedDomains: [],
    brandNames: ['Legacy'],
    trackedQueries: [{ id: assignedQueryId, query: 'Frozen legacy wording' }],
    locations: [],
    defaultContext: null,
    expectedSnapshots: 1,
  })
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision: 1,
    schemaVersion: 1,
    canonicalJson: canonicalMeasurementPlanJson(plan),
    checksum: 'a'.repeat(64),
    createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
}

function activateV2Plan(db: ReturnType<typeof createClient>, projectId: string, assignedQueryId = 'q-nearby'): string {
  const base = measurementPlanV2Fixture()
  const plan = measurementPlanV2Fixture({
    querySnapshots: base.querySnapshots.filter(snapshot => snapshot.queryId === 'q-nearby').map(snapshot => ({
      ...snapshot,
      queryId: assignedQueryId,
    })),
    assignments: base.assignments.filter(assignment => assignment.queryId === 'q-nearby').map(assignment => ({
      ...assignment,
      queryId: assignedQueryId,
    })),
    executionNodes: base.executionNodes.filter(node => node.queryId === 'q-nearby').map(node => ({
      ...node,
      queryId: assignedQueryId,
    })),
    usageEdges: base.usageEdges.filter(edge => edge.queryId === 'q-nearby').map(edge => ({
      ...edge,
      queryId: assignedQueryId,
    })),
  })
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision: 1,
    schemaVersion: 2,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: 'b'.repeat(64),
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
  return versionId
}

function seedDraft(db: ReturnType<typeof createClient>, projectId: string, assignedQueryId: string): void {
  db.insert(measurementPlanDrafts).values({
    id: crypto.randomUUID(),
    projectId,
    schemaVersion: 2,
    authoringJson: JSON.stringify({
      defaultContext: { providers: ['openai'], locations: [] },
      targets: [{
        stableKey: 'draft-target',
        label: 'Draft target',
        status: 'included',
        aliases: [],
        urlMatchers: ['https://draft.example'],
        source: 'manual',
      }],
      assignments: [{
        targetKey: 'draft-target',
        queryId: assignedQueryId,
        queryClass: 'non-brand',
        classificationSource: 'operator',
      }],
      groups: [],
    }),
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
}

function applyBody(name: string, queryTexts: string[], overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name },
    spec: {
      displayName: name,
      canonicalDomain: `${name}.example`,
      country: 'US',
      language: 'en',
      queries: queryTexts,
      ...overrides,
    },
  }
}

describe('legacy query catalog mutation guard', () => {
  it('rejects a v1 frozen raw-text relabel before catalog, snapshot, or query-set writes', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'legacy')
    const queryId = seedQuery(db, projectId, 'Frozen legacy wording', 'legacy-assigned')
    const snapshotId = seedSnapshot(db, projectId, queryId, 'Wording captured with the answer')
    const setId = crypto.randomUUID()
    const itemId = crypto.randomUUID()
    db.insert(measurementQuerySets).values({ id: setId, projectId, name: 'Legacy set', description: null, createdAt: NOW, updatedAt: NOW }).run()
    db.insert(measurementQuerySetItems).values({ id: itemId, querySetId: setId, queryId, position: 1, createdAt: NOW }).run()
    activateV1Plan(db, projectId, queryId)
    await app.ready()

    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/legacy/queries/replace-preview',
      payload: { queries: ['  Frozen legacy wording  '] },
    })
    expect(preview.statusCode).toBe(400)

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/legacy/queries',
      payload: { queries: ['  Frozen legacy wording  '] },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(db.select().from(queries).where(eq(queries.id, queryId)).get()).toMatchObject({ query: 'Frozen legacy wording' })
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, snapshotId)).get())
      .toMatchObject({ queryId, queryText: 'Wording captured with the answer' })
    expect(db.select().from(measurementQuerySetItems).where(eq(measurementQuerySetItems.id, itemId)).get())
      .toMatchObject({ queryId, position: 1 })
  })

  it('keeps active-v2 no-ops idempotent and allows cleanup of a truly unassigned catalog query', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'advanced')
    const assignedId = seedQuery(db, projectId, 'homes near harbor', 'q-nearby')
    const unassignedId = seedQuery(db, projectId, 'catalog-only question', 'catalog-only')
    const planVersionId = activateV2Plan(db, projectId, assignedId)
    db.insert(runs).values({
      id: crypto.randomUUID(),
      projectId,
      kind: 'answer-visibility',
      status: RunStatuses.queued,
      trigger: 'manual',
      measurementPlanVersionId: planVersionId,
      createdAt: NOW,
    }).run()
    await app.ready()

    const noop = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/advanced/queries',
      payload: { queries: ['homes near harbor', 'catalog-only question'] },
    })
    expect(noop.statusCode).toBe(200)
    expect(db.select().from(queries).where(eq(queries.id, assignedId)).get()).toMatchObject({ query: 'homes near harbor' })
    expect(db.select().from(queries).where(eq(queries.id, unassignedId)).get()).toMatchObject({ query: 'catalog-only question' })

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/advanced/queries',
      payload: { queries: ['catalog-only question'] },
    })
    expect(removed.statusCode).toBe(200)
    expect(db.select().from(queries).where(eq(queries.id, assignedId)).get()).toBeDefined()
    expect(db.select().from(queries).where(eq(queries.id, unassignedId)).get()).toBeUndefined()
  })

  it('blocks unassigned cleanup when a queued planless run predates a newly active v2 plan', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'late-plan')
    const assignedId = seedQuery(db, projectId, 'homes near harbor', 'q-nearby')
    const unassignedId = seedQuery(db, projectId, 'catalog-only question', 'catalog-only')
    db.insert(runs).values({
      id: crypto.randomUUID(),
      projectId,
      kind: 'answer-visibility',
      status: RunStatuses.queued,
      trigger: 'manual',
      createdAt: NOW,
    }).run()
    activateV2Plan(db, projectId, assignedId)
    await app.ready()

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/late-plan/queries',
      payload: { queries: ['catalog-only question'] },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'RUN_IN_PROGRESS' } })
    expect(db.select().from(queries).where(eq(queries.id, unassignedId)).get()).toBeDefined()
  })

  it('rejects a mixed v2 keyword delete atomically, leaving the unassigned row and its evidence untouched', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'alias-delete')
    const assignedId = seedQuery(db, projectId, 'homes near harbor', 'q-nearby')
    const unassignedId = seedQuery(db, projectId, 'catalog-only question', 'catalog-only')
    const snapshotId = seedSnapshot(db, projectId, unassignedId, null)
    activateV2Plan(db, projectId, assignedId)
    await app.ready()

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/projects/alias-delete/keywords',
      payload: { keywords: ['homes near harbor', 'catalog-only question'] },
    })

    expect(response.statusCode).toBe(400)
    expect(db.select().from(queries).where(eq(queries.id, assignedId)).get()).toBeDefined()
    expect(db.select().from(queries).where(eq(queries.id, unassignedId)).get()).toBeDefined()
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, snapshotId)).get())
      .toMatchObject({ queryId: unassignedId, queryText: null })
  })

  it('rejects an active-v2 keyword replacement that would remove its assigned catalog row', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'alias-replace')
    const assignedId = seedQuery(db, projectId, 'homes near harbor', 'q-nearby')
    const unassignedId = seedQuery(db, projectId, 'catalog-only question', 'catalog-only')
    activateV2Plan(db, projectId, assignedId)
    await app.ready()

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/alias-replace/keywords',
      payload: { keywords: ['catalog-only question'] },
    })

    expect(response.statusCode).toBe(400)
    expect(db.select().from(queries).where(eq(queries.id, assignedId)).get()).toBeDefined()
    expect(db.select().from(queries).where(eq(queries.id, unassignedId)).get()).toBeDefined()
  })

  it('blocks a draft-assigned query by the single-row delete endpoint while allowing no inference from draft existence alone', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'draft')
    const assignedId = seedQuery(db, projectId, 'Draft-managed wording', 'draft-assigned')
    const unassignedId = seedQuery(db, projectId, 'Draft catalog cleanup', 'draft-unassigned')
    seedDraft(db, projectId, assignedId)
    await app.ready()

    const protectedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/draft/queries/${assignedId}`,
    })
    expect(protectedDelete.statusCode).toBe(400)
    expect(db.select().from(queries).where(eq(queries.id, assignedId)).get()).toBeDefined()

    const cleanup = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/draft/queries/${unassignedId}`,
    })
    expect(cleanup.statusCode).toBe(204)
    expect(db.select().from(queries).where(eq(queries.id, unassignedId)).get()).toBeUndefined()
  })

  it('rolls back earlier apply config writes when the incoming query set would change an active plan', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'apply-guard', 'Original name')
    const assignedId = seedQuery(db, projectId, 'homes near harbor', 'q-nearby')
    activateV2Plan(db, projectId, assignedId)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: applyBody('apply-guard', ['replacement catalog wording'], {
        displayName: 'Changed name',
        canonicalDomain: 'changed.example',
      }),
    })

    expect(response.statusCode).toBe(400)
    expect(db.select().from(projects).where(eq(projects.id, projectId)).get())
      .toMatchObject({ displayName: 'Original name', canonicalDomain: 'apply-guard.example' })
    expect(db.select().from(queries).where(eq(queries.id, assignedId)).get())
      .toMatchObject({ query: 'homes near harbor' })
  })

  it('preserves frozen snapshot wording while filling only missing text during declarative replacement', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'evidence')
    const queryId = seedQuery(db, projectId, 'Old wording')
    const frozenId = seedSnapshot(db, projectId, queryId, 'Wording when captured')
    const missingId = seedSnapshot(db, projectId, queryId, null)
    await app.ready()

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/evidence/queries',
      payload: { queries: [] },
    })
    expect(response.statusCode).toBe(200)
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, frozenId)).get())
      .toMatchObject({ queryId: null, queryText: 'Wording when captured' })
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, missingId)).get())
      .toMatchObject({ queryId: null, queryText: 'Old wording' })
  })

  it('preserves frozen snapshot wording while filling only missing text during direct deletion', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'delete-evidence')
    const queryId = seedQuery(db, projectId, 'Deleted wording')
    const frozenId = seedSnapshot(db, projectId, queryId, 'Wording when captured')
    const missingId = seedSnapshot(db, projectId, queryId, null)
    await app.ready()

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/delete-evidence/queries/${queryId}`,
    })
    expect(response.statusCode).toBe(204)
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, frozenId)).get())
      .toMatchObject({ queryId: null, queryText: 'Wording when captured' })
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, missingId)).get())
      .toMatchObject({ queryId: null, queryText: 'Deleted wording' })
  })

  it('keeps a simple no-op allowed during an active run but rejects a real catalog change', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'simple-active')
    const queryId = seedQuery(db, projectId, 'Simple wording')
    db.insert(runs).values({
      id: crypto.randomUUID(),
      projectId,
      kind: 'answer-visibility',
      status: RunStatuses.queued,
      trigger: 'manual',
      createdAt: NOW,
    }).run()
    await app.ready()

    const noop = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/simple-active/queries',
      payload: { queries: ['Simple wording'] },
    })
    expect(noop.statusCode).toBe(200)
    expect(db.select().from(queries).where(eq(queries.id, queryId)).get()).toBeDefined()

    const changed = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/simple-active/queries',
      payload: { queries: ['Changed wording'] },
    })
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({ error: { code: 'RUN_IN_PROGRESS' } })
    expect(db.select().from(queries).where(eq(queries.id, queryId)).get()).toMatchObject({ query: 'Simple wording' })
  })

  it('retains the global read-only write gate before the single-query guard runs', async () => {
    const { app, db } = buildApp(false)
    const token = 'cnry_legacy_query_guard_reader'
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'reader',
      keyHash: hashApiKey(token),
      keyPrefix: token.slice(0, 9),
      scopes: ['read'],
      createdAt: NOW,
    }).run()
    const projectId = seedProject(db, 'readonly')
    const queryId = seedQuery(db, projectId, 'Read-only query')
    await app.ready()

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/readonly/queries/${queryId}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(db.select().from(queries).where(eq(queries.id, queryId)).get()).toBeDefined()
  })
})
