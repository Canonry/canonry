import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AppError,
  EMBED_QUERIES_WRITE_SCOPE,
  queryTrackingPreviewResponseSchema,
  queryTrackingWorkspaceResponseSchema,
} from '@canonry/canonry-contracts'
import { apiKeys, auditLog, createClient, migrate, projects, queries, type DatabaseClient } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { assertEmbedQueryWorkspace } from '../src/embed-queries.js'

const NOW = '2026-10-26T00:00:00.000Z'
const ROOT_KEY = 'cnry_embed_questions_root'
const QUESTION_KEY = 'cnry_embed_questions_dashboard'
const UNSCOPED_QUESTION_KEY = 'cnry_embed_questions_unscoped'
const READ_KEY = 'cnry_embed_questions_read'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

function addKey(raw: string, scopes: string[], projectId: string | null) {
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: raw, keyHash: hashApiKey(raw), keyPrefix: raw.slice(0, 9),
    scopes, projectId, createdAt: NOW,
  }).run()
}

function addProject(id: string, name: string) {
  db.insert(projects).values({
    id, name, displayName: name, canonicalDomain: `${name}.example`, ownedDomains: [], aliases: [],
    country: 'US', language: 'en', providers: ['openai'], providerModels: { openai: 'gpt-test' },
    locations: [], defaultLocation: null, createdAt: NOW, updatedAt: NOW,
  }).run()
}

function addQuestion(id: string, query: string) {
  db.insert(queries).values({ id, projectId: 'project-northwind', query, provenance: 'cli', createdAt: NOW }).run()
}

/** What the Embed v2 render proxy sends: the dashboard's tabs plus, when editing is on, its limit. */
function embedHeaders(key: string, limit: string | null = '3') {
  return {
    authorization: `Bearer ${key}`,
    'x-canonry-embed-tabs': 'overview',
    ...(limit === null ? {} : { 'x-canonry-embed-query-limit': limit }),
  }
}

/** The Questions tab reads its workspace through the proxy, with the dashboard read key. */
async function currentWorkspace() {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/northwind/query-tracking',
    headers: embedHeaders(READ_KEY),
  })
  expect(response.statusCode, response.body).toBe(200)
  return queryTrackingWorkspaceResponseSchema.parse(response.json())
}

type Mutation = Record<string, unknown>

async function review(mutation: Mutation, headers: Record<string, string> = embedHeaders(QUESTION_KEY), project = 'northwind') {
  const { workspaceVersion } = await currentWorkspace()
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/query-tracking/preview`,
    headers,
    payload: { additions: [], removals: [], ...mutation, expectedWorkspaceVersion: workspaceVersion },
  })
}

async function reviewAndSave(mutation: Mutation, saveHeaders: Record<string, string> = embedHeaders(QUESTION_KEY)) {
  const reviewed = await review(mutation)
  expect(reviewed.statusCode, reviewed.body).toBe(200)
  const preview = queryTrackingPreviewResponseSchema.parse(reviewed.json())
  return app.inject({
    method: 'POST',
    url: '/api/v1/projects/northwind/query-tracking/commit',
    headers: saveHeaders,
    payload: {
      additions: [], removals: [], ...mutation,
      expectedWorkspaceVersion: preview.workspaceVersion,
      previewToken: preview.previewToken,
      reviewedAt: preview.reviewedAt,
    },
  })
}

function trackedQuestions(): string[] {
  return db.select().from(queries).where(eq(queries.projectId, 'project-northwind')).all().map(row => row.query).sort()
}

const ADD = (text: string) => ({ additions: [{ input: { source: 'manual', text } }] })

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-embed-questions-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  addProject('project-northwind', 'northwind')
  addProject('project-other', 'other')
  addQuestion('q-existing', 'best solar installer in phoenix')
  addKey(ROOT_KEY, ['*'], null)
  addKey(QUESTION_KEY, [EMBED_QUERIES_WRITE_SCOPE], 'project-northwind')
  addKey(UNSCOPED_QUESTION_KEY, [EMBED_QUERIES_WRITE_SCOPE], null)
  addKey(READ_KEY, ['read', 'embed'], 'project-northwind')
  // Every platform-provisioned embed instance carries an install-wide tab allowlist.
  app = Fastify()
  app.register(apiRoutes, { db, embedProjectTabs: ['overview', 'technical-aeo'], getRunnableProviderNames: () => ['openai'] })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('embedded dashboards: the Questions tab reads', () => {
  it('reads the question workspace only when the proxy grants editing', async () => {
    const granted = await app.inject({ method: 'GET', url: '/api/v1/projects/northwind/query-tracking', headers: embedHeaders(READ_KEY) })
    expect(granted.statusCode, granted.body).toBe(200)
    const refused = await app.inject({ method: 'GET', url: '/api/v1/projects/northwind/query-tracking', headers: embedHeaders(READ_KEY, null) })
    expect(refused.statusCode).toBe(403)
    // The grant opens the question workspace only, not other reads such as the schedule.
    const schedule = await app.inject({ method: 'GET', url: '/api/v1/projects/northwind/schedule', headers: embedHeaders(READ_KEY) })
    expect(schedule.statusCode).toBe(403)
  })

  it('ignores a malformed or out-of-range limit header', async () => {
    for (const limit of ['0', '-1', '10.5', '1001', 'ten', '']) {
      const refused = await app.inject({ method: 'GET', url: '/api/v1/projects/northwind/query-tracking', headers: embedHeaders(READ_KEY, limit) })
      expect(refused.statusCode, `limit=${limit}`).toBe(403)
    }
  })
})

describe('embedded dashboards: question changes', () => {
  it('adds one written question through review and save, and records that it came from the embed', async () => {
    const saved = await reviewAndSave(ADD('Who installs solar panels near Tempe?'))
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({ committed: true })
    expect(trackedQuestions()).toEqual(['Who installs solar panels near Tempe?', 'best solar installer in phoenix'])
    const audit = db.select().from(auditLog).all().filter(row => row.action === 'query-tracking.updated')
    expect(audit).toHaveLength(1)
    expect(JSON.parse(String(audit[0]!.diff))).toMatchObject({ added: 1, via: 'embed' })
  })

  it('removes one question by id', async () => {
    const removed = await reviewAndSave({ removals: [{ queryId: 'q-existing' }] })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(trackedQuestions()).toEqual([])
  })

  it('refuses anything but one plain change', async () => {
    const refusedChanges: Mutation[] = [
      { additions: [{ input: { source: 'manual', text: 'one' } }, { input: { source: 'manual', text: 'two' } }] },
      { additions: [{ input: { source: 'research', researchRunQueryId: 'research-query-1' } }] },
      { additions: [{ input: { source: 'manual', text: 'scoped' }, audience: { targetKeys: ['t-1'] } }] },
      { additions: [{ input: { source: 'manual', text: 'classified' }, queryClass: 'branded' }] },
      { removals: [{ queryText: 'best solar installer in phoenix' }] },
      { edits: [{ queryId: 'q-existing', queryClass: 'branded' }] },
      { edits: [{ queryId: 'q-existing', text: 'reworded question' }] },
      { additions: [{ input: { source: 'manual', text: 'new' } }], removals: [{ queryId: 'q-existing' }] },
      { additions: [], removals: [] },
    ]
    for (const mutation of refusedChanges) {
      const response = await review(mutation)
      expect(response.statusCode, JSON.stringify(mutation)).toBe(403)
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN', message: 'An embedded dashboard can add or remove one query at a time.' } })
    }
    expect(trackedQuestions()).toEqual(['best solar installer in phoenix'])
  })

  it('keeps the list within the dashboard limit at review', async () => {
    const response = await review(ADD('one question too many'), embedHeaders(QUESTION_KEY, '1'))
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'EMBED_QUERY_LIMIT', details: { limit: 1, attempted: 2 } } })
  })

  it('checks the limit again at save, when the plan dropped after review', async () => {
    const response = await reviewAndSave(ADD('reviewed under a larger plan'), embedHeaders(QUESTION_KEY, '1'))
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'EMBED_QUERY_LIMIT' } })
    expect(trackedQuestions()).toEqual(['best solar installer in phoenix'])
  })

  it('lets a list that is over the limit be shortened', async () => {
    addQuestion('q-second', 'solar panel cost in phoenix')
    addQuestion('q-third', 'is solar worth it in arizona')
    const atTwo = embedHeaders(QUESTION_KEY, '2')

    const removed = await reviewAndSave({ removals: [{ queryId: 'q-third' }] }, atTwo)
    expect(removed.statusCode, removed.body).toBe(200)
    expect(trackedQuestions()).toEqual(['best solar installer in phoenix', 'solar panel cost in phoenix'])

    const added = await review(ADD('a third question again'), atTwo)
    expect(added.statusCode).toBe(409)
  })
})

describe('embedded dashboards: who may change questions', () => {
  it('refuses the question key without the limit header', async () => {
    const response = await review(ADD('no limit header'), embedHeaders(QUESTION_KEY, null))
    expect(response.statusCode).toBe(403)
    expect(response.json().error.message).toBe('An embedded query change needs the dashboard query limit.')
  })

  it('refuses a question key that is not scoped to one project', async () => {
    const response = await review(ADD('unscoped key'), embedHeaders(UNSCOPED_QUESTION_KEY))
    expect(response.statusCode).toBe(403)
    expect(response.json().error.message).toBe('An embedded query key must be scoped to one project.')
  })

  it('confines the question key to its own project and the two question routes', async () => {
    const otherProject = await review(ADD('another project'), embedHeaders(QUESTION_KEY), 'other')
    expect(otherProject.statusCode).toBe(403)
    expect(otherProject.json().error.message).toBe('This API key is scoped to a different project.')

    const schedule = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/northwind/schedule',
      headers: embedHeaders(QUESTION_KEY),
      payload: { preset: 'daily', providers: [] },
    })
    expect(schedule.statusCode).toBe(403)
    expect(schedule.json().error.message).toBe('This credential can only perform operations explicitly granted by its scopes.')

    const replace = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/northwind/queries',
      headers: embedHeaders(QUESTION_KEY),
      payload: { queries: ['replaced everything'] },
    })
    expect(replace.statusCode).toBe(403)
    expect(replace.json().error.message).toBe('This credential can only perform operations explicitly granted by its scopes.')
    expect(trackedQuestions()).toEqual(['best solar installer in phoenix'])
  })

  it('keeps the dashboard read key read-only, even with the limit header', async () => {
    const response = await review(ADD('read key write'), embedHeaders(READ_KEY))
    expect(response.statusCode).toBe(403)
    expect(response.json().error.message).toBe('This API key is read-only and cannot perform write operations.')
  })

  it('leaves full-authority callers on the operator rules', async () => {
    const response = await review(
      { additions: [{ input: { source: 'manual', text: 'first' } }, { input: { source: 'manual', text: 'second' } }] },
      { authorization: `Bearer ${ROOT_KEY}`, 'x-canonry-embed-query-limit': '1' },
    )
    expect(response.statusCode, response.body).toBe(200)
  })

  it('leaves advanced portfolios with the agency', () => {
    expect(() => assertEmbedQueryWorkspace('advanced')).toThrow(AppError)
    expect(() => assertEmbedQueryWorkspace('simple')).not.toThrow()
  })
})
