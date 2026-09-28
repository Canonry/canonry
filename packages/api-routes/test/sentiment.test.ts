import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSimpleMeasurementDefinition, sentimentSummarySchema } from '@ainyc/canonry-contracts'
import { apiKeys, createClient, migrate, projects, queries, querySnapshots, runs, simpleMeasurementDefinitions, SentimentRepository, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { SentimentService } from '../src/sentiment-service.js'

let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let service: SentimentService
let installEnabled = true
let clock = '2026-09-28T00:00:00.000Z'
const now = () => new Date(clock)
const install = () => ({ enabled: installEnabled, ready: installEnabled, model: 'jev-1.13.0', reason: installEnabled ? null : 'install-disabled' })
beforeEach(async () => {
  installEnabled = true; clock = '2026-09-28T00:00:00.000Z'
  db = createClient(':memory:'); migrate(db)
  for (const id of ['p', 'other']) db.insert(projects).values({ id, name: id, displayName: 'Acme', canonicalDomain: 'https://Acme.Example/', country: 'US', language: 'en', createdAt: clock, updatedAt: clock }).run()
  db.insert(queries).values({ id: 'q', projectId: 'p', query: 'Acme reviews', createdAt: clock }).run()
  db.insert(runs).values({ id: 'r', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: clock }).run()
  db.insert(querySnapshots).values({ id: 's', runId: 'r', queryId: 'q', provider: 'openai', model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: 'Acme is excellent.', citationState: 'cited', createdAt: clock }).run()
  db.insert(simpleMeasurementDefinitions).values({ runId: 'r', projectId: 'p', checksum: 'x', capturedAt: clock, definition: buildSimpleMeasurementDefinition({ capturedAt: clock, identity: { displayName: 'Acme', aliases: [], canonicalDomain: 'https://Acme.Example/', ownedDomains: [] }, country: 'US', language: 'en', location: null, engines: [{ provider: 'openai', requestedModel: 'gpt-test' }], queries: [{ queryId: 'q', queryText: 'Acme reviews', provenance: null }] }) }).run()
  for (const [id, scopes, projectId] of [['root', ['*'], null], ['read', ['read'], null], ['narrow', ['sentiment.write'], null], ['scoped', ['*'], 'p'], ['accounts', ['users.write'], null]] as const) db.insert(apiKeys).values({ id, name: id, keyHash: hashApiKey(`cnry_${id}`), keyPrefix: 'cnry_test', scopes: [...scopes], projectId, createdAt: clock }).run()
  const options = { install, now, previewSecret: 'test-preview-secret' }
  service = new SentimentService(db, options)
  app = Fastify()
  app.register(apiRoutes, { db, sentiment: options })
  await app.ready()
})
afterEach(async () => { await app.close(); db.$client.close() })
function request(method: 'GET' | 'PUT' | 'POST', path: string, key = 'root', payload?: unknown) { return app.inject({ method, url: `/api/v1/projects/p/sentiment${path}`, headers: { authorization: `Bearer cnry_${key}` }, ...(payload !== undefined ? { payload } : {}) }) }
// The standalone registration receives the API prefix explicitly in beforeEach below.

describe('sentiment stored API', () => {
  it('exposes default-off settings and null score without secrets', async () => {
    const settings = await request('GET', '/settings', 'read')
    expect(settings.statusCode).toBe(200)
    expect(settings.json()).toMatchObject({ enabled: false, actions: { configure: false, backfill: false } })
    const summary = await request('GET', '', 'read')
    expect(summary.statusCode).toBe(200)
    expect(sentimentSummarySchema.parse(summary.json()).score.favorableRate).toBeNull()
  })
  it.each(['read', 'narrow', 'scoped', 'accounts'])('denies configuration to %s credentials', async key => {
    const response = await request('PUT', '/settings', key, { enabled: true })
    expect(response.statusCode).toBe(403)
  })
  it('admits a frozen preview and replays its receipt after expiry and disablement', async () => {
    expect((await request('PUT', '/settings', 'root', { enabled: true })).statusCode).toBe(200)
    const preview = await request('GET', '/backfill-preview?runId=r')
    expect(preview.statusCode).toBe(200)
    expect(preview.json().eligibleAssessments).toBe(1)
    const body = { previewToken: preview.json().previewToken, idempotencyKey: 'one' }
    const first = await request('POST', '/backfills', 'root', body)
    expect(first.statusCode).toBe(200)
    clock = '2026-09-29T00:00:00.000Z'
    await request('PUT', '/settings', 'root', { enabled: false })
    const repeat = await request('POST', '/backfills', 'root', body)
    expect(repeat.statusCode).toBe(200)
    expect(repeat.json().id).toBe(first.json().id)
    expect(repeat.json().counts.canceled).toBe(1)
    const conflict = await request('POST', '/backfills', 'root', { ...body, previewToken: `${body.previewToken}x` })
    expect(conflict.statusCode).toBe(409)
  })
  it('read-only preview and summary create no job or attempt', async () => {
    service.configure('p', { enabled: true })
    expect((await request('GET', '/backfill-preview?runId=r', 'read')).statusCode).toBe(200)
    expect((await request('GET', '', 'read')).statusCode).toBe(200)
    expect(service.jobs('p').jobs).toEqual([])
  })
  it('prevents a scoped reader from another project and wrong-project jobs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/other/sentiment/settings', headers: { authorization: 'Bearer cnry_scoped' } })
    expect(response.statusCode).toBe(403)
    expect((await request('GET', '/jobs/not-here')).statusCode).toBe(404)
  })
  it('validates non-project scope and unsupported non-brand state', async () => {
    expect((await request('GET', '?scope=market')).statusCode).toBe(400)
    const response = await request('GET', '?queryClass=non-brand')
    expect(response.json().state).toBe('unsupported')
  })
  it('rejects stale evidence after answer text changes', async () => {
    service.configure('p', { enabled: true })
    const preview = service.preview('p', { runId: 'r' })
    const job = service.submit('p', preview.previewToken!, 'done', 'test')
    const repository = new SentimentRepository(db)
    const work = repository.claim({ owner: 'test', now: clock, leaseMs: 10_000 })!
    repository.completeWork({ workItemId: work.id, owner: 'test', now: clock, outcome: 'favorable', returnedModel: 'jev-1.13.0', result: { kind: 'classified', outcome: 'favorable', returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 1 }, conclusion: [{ id: 's1', text: 'Acme is excellent.', start: 0, end: 18 }], complaint: null, themes: [], confidence: null } })
    expect(service.job('p', job.id).state).toBe('complete')
    const query = { mode: 'auto' as const, queryClass: 'branded' as const, scope: 'project' as const, runId: 'r' }
    expect(service.summary('p', query).coverage.judged).toBe(1)
    db.$client.prepare('UPDATE query_snapshots SET answer_text = ? WHERE id = ?').run('Acme is awful.', 's')
    expect(service.summary('p', query).coverage.judged).toBe(0)
  })
})
