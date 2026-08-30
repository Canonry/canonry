import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
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
  users,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { createUserSession, USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function buildApp(skipAuth = true) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-simple-replace-'))
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

function seedProject(db: ReturnType<typeof createClient>, name: string): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name,
    displayName: name,
    canonicalDomain: `${name}.example`,
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

function seedQuery(db: ReturnType<typeof createClient>, projectId: string, query: string): string {
  const id = crypto.randomUUID()
  db.insert(queries).values({
    id,
    projectId,
    query,
    provenance: 'test',
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function seedSnapshot(
  db: ReturnType<typeof createClient>,
  projectId: string,
  queryId: string,
  queryText: string | null,
): string {
  const now = new Date().toISOString()
  const runId = crypto.randomUUID()
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: now,
    finishedAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id,
    runId,
    queryId,
    queryText,
    provider: 'gemini',
    citationState: 'cited',
    citedDomains: [],
    competitorOverlap: [],
    recommendedCompetitors: [],
    createdAt: now,
  }).run()
  return id
}

function seedActivePlan(db: ReturnType<typeof createClient>, projectId: string): void {
  const now = new Date().toISOString()
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision: 1,
    canonicalJson: '{"schemaVersion":1,"targets":[],"groups":[],"targetQuerySelections":[]}',
    checksum: 'test-checksum',
    createdAt: now,
  }).run()
  db.insert(measurementPlans).values({
    projectId,
    activeVersionId: versionId,
    createdAt: now,
    updatedAt: now,
  }).run()
}

function seedDraft(db: ReturnType<typeof createClient>, projectId: string): void {
  const now = new Date().toISOString()
  db.insert(measurementPlanDrafts).values({
    id: crypto.randomUUID(),
    projectId,
    authoringJson: '{"schemaVersion":2,"targets":[],"groups":[],"assignments":[]}',
    createdBy: 'test',
    updatedBy: 'test',
    createdAt: now,
    updatedAt: now,
  }).run()
}

function replace(
  app: ReturnType<typeof Fastify>,
  project: string,
  id: string,
  query: string,
  expectedQuery: string,
  token?: string,
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/queries/${id}/replace`,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    payload: { query, expectedQuery },
  })
}

describe('POST /projects/:name/queries/:id/replace', () => {
  it('creates a new query identity, freezes only missing snapshot text, and leaves siblings alone', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'simple')
    const oldId = seedQuery(db, projectId, 'Old wording')
    const siblingId = seedQuery(db, projectId, 'Unaffected sibling')
    const frozenSnapshotId = seedSnapshot(db, projectId, oldId, 'Wording when this answer was captured')
    const missingSnapshotId = seedSnapshot(db, projectId, oldId, null)
    await app.ready()

    const response = await replace(app, 'simple', oldId, 'New wording', 'Old wording')
    expect(response.statusCode).toBe(200)
    const body = response.json() as { id: string; query: string; createdAt: string }
    expect(body).toMatchObject({ query: 'New wording' })
    expect(body.id).not.toBe(oldId)

    expect(db.select().from(queries).where(eq(queries.id, oldId)).get()).toBeUndefined()
    expect(db.select().from(queries).where(eq(queries.id, body.id)).get()).toMatchObject({
      id: body.id,
      projectId,
      query: 'New wording',
      provenance: `query-edit:${oldId}`,
    })
    expect(db.select().from(queries).where(eq(queries.id, siblingId)).get()).toMatchObject({
      id: siblingId,
      query: 'Unaffected sibling',
    })

    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, frozenSnapshotId)).get())
      .toMatchObject({ queryId: null, queryText: 'Wording when this answer was captured' })
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, missingSnapshotId)).get())
      .toMatchObject({ queryId: null, queryText: 'Old wording' })
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.queryId, body.id)).all()).toEqual([])
  })

  it('moves only the source query-set memberships to the new identity without changing their rows or positions', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'sets')
    const sourceId = seedQuery(db, projectId, 'Old wording')
    const siblingId = seedQuery(db, projectId, 'Sibling wording')
    const now = new Date().toISOString()
    const firstSetId = crypto.randomUUID()
    const secondSetId = crypto.randomUUID()
    const firstSourceItemId = crypto.randomUUID()
    const firstSiblingItemId = crypto.randomUUID()
    const secondSourceItemId = crypto.randomUUID()
    const secondSiblingItemId = crypto.randomUUID()
    db.insert(measurementQuerySets).values([
      { id: firstSetId, projectId, name: 'First set', description: null, createdAt: now, updatedAt: now },
      { id: secondSetId, projectId, name: 'Second set', description: null, createdAt: now, updatedAt: now },
    ]).run()
    db.insert(measurementQuerySetItems).values([
      { id: firstSourceItemId, querySetId: firstSetId, queryId: sourceId, position: 3, createdAt: now },
      { id: firstSiblingItemId, querySetId: firstSetId, queryId: siblingId, position: 4, createdAt: now },
      { id: secondSourceItemId, querySetId: secondSetId, queryId: sourceId, position: 8, createdAt: now },
      { id: secondSiblingItemId, querySetId: secondSetId, queryId: siblingId, position: 9, createdAt: now },
    ]).run()
    await app.ready()

    const response = await replace(app, 'sets', sourceId, 'New wording', 'Old wording')
    expect(response.statusCode).toBe(200)
    const replacementId = (response.json() as { id: string }).id

    expect(db.select().from(measurementQuerySetItems).where(eq(measurementQuerySetItems.id, firstSourceItemId)).get())
      .toMatchObject({ id: firstSourceItemId, querySetId: firstSetId, queryId: replacementId, position: 3, createdAt: now })
    expect(db.select().from(measurementQuerySetItems).where(eq(measurementQuerySetItems.id, secondSourceItemId)).get())
      .toMatchObject({ id: secondSourceItemId, querySetId: secondSetId, queryId: replacementId, position: 8, createdAt: now })
    expect(db.select().from(measurementQuerySetItems).where(eq(measurementQuerySetItems.id, firstSiblingItemId)).get())
      .toMatchObject({ id: firstSiblingItemId, querySetId: firstSetId, queryId: siblingId, position: 4, createdAt: now })
    expect(db.select().from(measurementQuerySetItems).where(eq(measurementQuerySetItems.id, secondSiblingItemId)).get())
      .toMatchObject({ id: secondSiblingItemId, querySetId: secondSetId, queryId: siblingId, position: 9, createdAt: now })
  })

  it('keeps the source identity for a normalized no-op', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'noop')
    const id = seedQuery(db, projectId, 'Old wording')
    const now = new Date().toISOString()
    const querySetId = crypto.randomUUID()
    const membershipId = crypto.randomUUID()
    db.insert(measurementQuerySets).values({
      id: querySetId, projectId, name: 'No-op set', description: null, createdAt: now, updatedAt: now,
    }).run()
    db.insert(measurementQuerySetItems).values({
      id: membershipId, querySetId, queryId: id, position: 2, createdAt: now,
    }).run()
    await app.ready()

    const response = await replace(app, 'noop', id, '  OLD WORDING  ', 'Old wording')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id, query: 'Old wording' })
    expect(db.select().from(queries).where(eq(queries.projectId, projectId)).all()).toHaveLength(1)
    expect(db.select().from(queries).where(eq(queries.id, id)).get()).toMatchObject({ query: 'Old wording' })
    expect(db.select().from(measurementQuerySetItems).where(eq(measurementQuerySetItems.id, membershipId)).get())
      .toMatchObject({ id: membershipId, querySetId, queryId: id, position: 2, createdAt: now })
  })

  it('refuses a normalized collision without merging the two catalog rows', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'collision')
    const sourceId = seedQuery(db, projectId, 'Old wording')
    const collisionId = seedQuery(db, projectId, 'New wording')
    await app.ready()

    const response = await replace(app, 'collision', sourceId, '  new wording ', 'Old wording')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'ALREADY_EXISTS' } })
    expect(db.select().from(queries).where(eq(queries.id, sourceId)).get()).toMatchObject({ query: 'Old wording' })
    expect(db.select().from(queries).where(eq(queries.id, collisionId)).get()).toMatchObject({ query: 'New wording' })
  })

  it('refuses stale text and a retry against an already-replaced source without creating extra rows', async () => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, 'stale')
    const sourceId = seedQuery(db, projectId, 'Old wording')
    await app.ready()

    const stale = await replace(app, 'stale', sourceId, 'New wording', 'Old wording from a stale tab')
    expect(stale.statusCode).toBe(400)
    expect(db.select().from(queries).where(eq(queries.id, sourceId)).get()).toMatchObject({ query: 'Old wording' })

    const first = await replace(app, 'stale', sourceId, 'New wording', 'Old wording')
    expect(first.statusCode).toBe(200)
    const replacementId = (first.json() as { id: string }).id
    const retry = await replace(app, 'stale', sourceId, 'New wording', 'Old wording')
    expect(retry.statusCode).toBe(404)
    const rows = db.select().from(queries).where(eq(queries.projectId, projectId)).all()
    expect(rows).toEqual([expect.objectContaining({ id: replacementId, query: 'New wording' })])
  })

  it('does not cross projects when the source ID belongs to another project', async () => {
    const { app, db } = buildApp()
    const firstProject = seedProject(db, 'first')
    seedProject(db, 'second')
    const sourceId = seedQuery(db, firstProject, 'Private query')
    await app.ready()

    const response = await replace(app, 'second', sourceId, 'New query', 'Private query')
    expect(response.statusCode).toBe(404)
    expect(db.select().from(queries).where(eq(queries.id, sourceId)).get()).toMatchObject({
      projectId: firstProject,
      query: 'Private query',
    })
  })

  it('refuses a project with an active plan or an authoring draft', async () => {
    const { app, db } = buildApp()
    const plannedProjectId = seedProject(db, 'planned')
    const plannedQueryId = seedQuery(db, plannedProjectId, 'Plan question')
    seedActivePlan(db, plannedProjectId)
    const draftProjectId = seedProject(db, 'drafted')
    const draftQueryId = seedQuery(db, draftProjectId, 'Draft question')
    seedDraft(db, draftProjectId)
    await app.ready()

    for (const [project, id, old] of [
      ['planned', plannedQueryId, 'Plan question'],
      ['drafted', draftQueryId, 'Draft question'],
    ] as const) {
      const response = await replace(app, project, id, 'Replacement', old)
      expect(response.statusCode).toBe(400)
      expect(db.select().from(queries).where(eq(queries.id, id)).get()).toMatchObject({ query: old })
    }
  })

  it.each(['queued', 'running'] as const)('refuses a %s answer-visibility run', async (status) => {
    const { app, db } = buildApp()
    const projectId = seedProject(db, `run-${status}`)
    const sourceId = seedQuery(db, projectId, 'Old wording')
    db.insert(runs).values({
      id: crypto.randomUUID(),
      projectId,
      kind: 'answer-visibility',
      status,
      trigger: 'manual',
      createdAt: new Date().toISOString(),
    }).run()
    await app.ready()

    const response = await replace(app, `run-${status}`, sourceId, 'New wording', 'Old wording')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'RUN_IN_PROGRESS' } })
    expect(db.select().from(queries).where(eq(queries.id, sourceId)).get()).toMatchObject({ query: 'Old wording' })
  })

  it('inherits the global read-only write gate', async () => {
    const { app, db } = buildApp(false)
    const readOnlyToken = 'cnry_simple_replace_read_only'
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'reader',
      keyHash: hashApiKey(readOnlyToken),
      keyPrefix: readOnlyToken.slice(0, 9),
      scopes: ['read'],
      createdAt: new Date().toISOString(),
    }).run()
    const projectId = seedProject(db, 'readonly')
    const sourceId = seedQuery(db, projectId, 'Old wording')
    await app.ready()

    const response = await replace(app, 'readonly', sourceId, 'New wording', 'Old wording', readOnlyToken)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(db.select().from(queries).where(and(eq(queries.projectId, projectId), eq(queries.id, sourceId))).get())
      .toMatchObject({ query: 'Old wording' })
  })

  it('inherits the global viewer write gate', async () => {
    const { app, db } = buildApp(false)
    const projectId = seedProject(db, 'viewer')
    const sourceId = seedQuery(db, projectId, 'Old wording')
    const viewerId = crypto.randomUUID()
    db.insert(users).values({
      id: viewerId,
      name: 'Viewer',
      nameKey: 'viewer',
      passwordHash: 'test-only-password-hash',
      role: 'viewer',
      createdAt: new Date().toISOString(),
    }).run()
    const sessionId = createUserSession(db, viewerId)
    await app.ready()

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/viewer/queries/${sourceId}/replace`,
      headers: {
        cookie: `${USER_SESSION_COOKIE_NAME}=${sessionId}`,
        origin: 'http://localhost:4100',
        host: 'localhost:4100',
      },
      payload: { query: 'New wording', expectedQuery: 'Old wording' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(db.select().from(queries).where(eq(queries.id, sourceId)).get()).toMatchObject({ query: 'Old wording' })
  })

  it('publishes the guarded identity-replacement contract to OpenAPI', async () => {
    const { app } = buildApp()
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(response.statusCode).toBe(200)
    const document = response.json() as {
      paths: Record<string, Record<string, {
        requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> }
        responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>
      }>>
      components?: { schemas?: Record<string, { required?: string[]; additionalProperties?: boolean }> }
    }
    const operation = document.paths['/api/v1/projects/{name}/queries/{id}/replace']?.post
    expect(operation?.requestBody?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/QueryReplaceRequest')
    expect(operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref)
      .toBe('#/components/schemas/QueryDto')
    expect(document.components?.schemas?.QueryReplaceRequest).toMatchObject({
      required: ['query', 'expectedQuery'],
      additionalProperties: false,
    })
  })
})
