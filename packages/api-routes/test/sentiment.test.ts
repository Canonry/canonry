import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSimpleMeasurementDefinition, createSentimentEvaluationDefinition, sentimentSummarySchema } from '@ainyc/canonry-contracts'
import { apiKeys, createClient, migrate, projects, queries, querySnapshots, runs, sentimentAttempts, sentimentJobs, simpleMeasurementDefinitions, users, SentimentRepository, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes, createUserSession, USER_SESSION_COOKIE_NAME } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { SentimentService } from '../src/sentiment-service.js'
import { sentimentHash } from '../src/sentiment-input.js'

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

  it('binds exact assessment evidence to current project, run, class, provider, model, query and cursor scope', async () => {
    service.configure('p', { enabled: true })
    const stored = db.select().from(simpleMeasurementDefinitions).get()!
    db.insert(runs).values({ id: 'r2', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: clock }).run()
    db.insert(simpleMeasurementDefinitions).values({ ...stored, runId: 'r2' }).run()
    db.insert(querySnapshots).values({ id: 's2', runId: 'r2', queryId: 'q', provider: 'openai', model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: 'Acme is disappointing.', citationState: 'cited', createdAt: clock }).run()
    const preview = service.preview('p', { runIds: ['r', 'r2'] })
    service.submit('p', preview.previewToken!, 'exact-evidence', 'test')
    const repository = new SentimentRepository(db)
    for (;;) {
      const work = repository.claim({ owner: 'exact', now: clock, leaseMs: 10_000 })
      if (!work) break
      const input = work.input as { sentences: Array<{ id: string; text: string; start: number; end: number }> }
      const outcome = work.runId === 'r' ? 'favorable' : 'unfavorable'
      repository.completeWork({ workItemId: work.id, owner: 'exact', now: clock, outcome, returnedModel: 'jev-1.13.0', result: { kind: 'classified', outcome, returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 1 }, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null } })
    }
    const summary = await request('GET', '?runIds=r&runIds=r2&include=assessments', 'read')
    const target = sentimentSummarySchema.parse(summary.json()).queries[0]!.assessments.find(item => item.sourceSnapshotId === 's')!
    const jobsBefore = db.select().from(sentimentJobs).all(), attemptsBefore = db.select().from(sentimentAttempts).all()
    const selected = await request('GET', `/evidence?runIds=r&runIds=r2&assessmentId=${target.assessmentId}`, 'read')
    expect(selected.statusCode, selected.body).toBe(200)
    expect(selected.json().selection.assessmentId).toBe(target.assessmentId)
    expect(selected.json().items).toHaveLength(1)
    expect(selected.json().items[0]).toMatchObject({ assessmentId: target.assessmentId, runId: 'r', sourceSnapshotId: 's', outcome: 'favorable' })
    // An exact ID cannot widen a valid but different evaluator selection.
    const nextDefinition = { ...createSentimentEvaluationDefinition(), confidenceThreshold: 0.8 }
    const nextDefinitionId = sentimentHash(nextDefinition)
    repository.putDefinition({ id: nextDefinitionId, contentHash: nextDefinitionId, requestedModel: nextDefinition.requestedModel, definition: nextDefinition, createdAt: clock })
    repository.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: nextDefinitionId, configuration: { enabled: true }, now: clock })
    const differentEvaluator = await request('GET', `/evidence?runId=r&evaluationDefinitionId=${nextDefinitionId}&assessmentId=${target.assessmentId}`, 'read')
    expect(differentEvaluator.statusCode, differentEvaluator.body).toBe(200)
    expect(differentEvaluator.json().items).toEqual([])
    const unknownAssessment = await request('GET', '/evidence?runId=r&assessmentId=unknown-assessment', 'read')
    expect(unknownAssessment.statusCode).toBe(200)
    expect(unknownAssessment.json().items).toEqual([])
    for (const refinement of ['runId=r2', 'runId=r&queryClass=non-brand', 'runId=r&provider=gemini', 'runId=r&model=other', 'runId=r&queryId=other', 'runId=r&location=elsewhere']) {
      const hidden = await request('GET', `/evidence?${refinement}&assessmentId=${target.assessmentId}`, 'read')
      expect(hidden.statusCode, hidden.body).toBe(200)
      expect(hidden.json().items).toEqual([])
    }
    expect((await request('GET', `?assessmentId=${target.assessmentId}`, 'read')).statusCode).toBe(400)
    const first = await request('GET', '/evidence?runIds=r&runIds=r2&limit=1', 'read')
    expect(first.json().nextCursor).not.toBeNull()
    const escaped = await request('GET', `/evidence?runIds=r&runIds=r2&limit=1&assessmentId=${target.assessmentId}&cursor=${encodeURIComponent(first.json().nextCursor)}`, 'read')
    expect(escaped.statusCode).toBe(400)
    const foreign = await app.inject({ method: 'GET', url: `/api/v1/projects/other/sentiment/evidence?runId=r&assessmentId=${target.assessmentId}`, headers: { authorization: 'Bearer cnry_scoped' } })
    expect(foreign.statusCode).toBe(403)
    const unavailable = await app.inject({ method: 'GET', url: `/api/v1/projects/other/sentiment/evidence?runId=r&assessmentId=${target.assessmentId}`, headers: { authorization: 'Bearer cnry_root' } })
    expect(unavailable.statusCode).toBe(404)
    expect(db.select().from(sentimentJobs).all()).toEqual(jobsBefore)
    expect(db.select().from(sentimentAttempts).all()).toEqual(attemptsBefore)
  })

  it('refuses evaluator metadata belonging only to another project', async () => {
    const settings = service.configure('other', { enabled: true })
    const response = await request('GET', `?evaluationDefinitionId=${settings.evaluationDefinitionId}`, 'scoped')
    expect(response.statusCode).toBe(404)
  })


  it.each(['admin', 'viewer'] as const)('retains %s authority for named sessions and delegated MCP credentials', async role => {
    db.insert(users).values({ id: role, name: role, nameKey: role, passwordHash: 'unused', role, createdAt: clock }).run()
    db.insert(apiKeys).values({ id: `delegated-${role}`, name: 'delegated', keyHash: hashApiKey(`cnry_delegated-${role}`), keyPrefix: 'cnry_test', scopes: ['*'], delegatedUserId: role, createdAt: clock }).run()
    const cookie = `${USER_SESSION_COOKIE_NAME}=${createUserSession(db, role)}`
    const session = await app.inject({ method: 'PUT', url: '/api/v1/projects/p/sentiment/settings', headers: { cookie, host: 'localhost', origin: 'http://localhost' }, payload: { enabled: true } })
    expect(session.statusCode).toBe(role === 'admin' ? 200 : 403)
    expect((await request('PUT', '/settings', `delegated-${role}`, { enabled: true })).statusCode).toBe(role === 'admin' ? 200 : 403)
    expect((await request('GET', '/settings', `delegated-${role}`)).statusCode).toBe(200)
  })


  it('compares different answer text under the same evaluator and refuses source model drift', () => {
    service.configure('p', { enabled: true })
    const original = db.select().from(simpleMeasurementDefinitions).get()!
    for (const [runId, text, servedModel] of [['r2', 'Acme has excellent quality.', 'gpt-test-v1'], ['r3', 'Acme is reliable.', 'gpt-test-v2']]) {
      db.insert(runs).values({ id: runId!, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: clock }).run()
      db.insert(querySnapshots).values({ id: `s-${runId}`, runId: runId!, queryId: 'q', provider: 'openai', model: 'gpt-test', servedModel, answerText: text, citationState: 'cited', createdAt: clock }).run()
      db.insert(simpleMeasurementDefinitions).values({ ...original, runId: runId! }).run()
    }
    const repository = new SentimentRepository(db)
    for (const runId of ['r', 'r2', 'r3']) {
      const preview = service.preview('p', { runId })
      service.submit('p', preview.previewToken!, runId, 'test')
      const work = repository.claim({ owner: 'comparison', now: clock, leaseMs: 10_000 })!
      const input = work.input as { sentences: Array<{ id: string; text: string; start: number; end: number }> }
      repository.completeWork({ workItemId: work.id, owner: 'comparison', now: clock, outcome: 'favorable', returnedModel: 'jev-1.13.0', result: { kind: 'classified', outcome: 'favorable', returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 1 }, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null } })
    }
    const query = { mode: 'auto' as const, queryClass: 'branded' as const, scope: 'project' as const }
    expect(service.compare('p', query, 'r', 'r2')).toMatchObject({ verdict: 'no-clear-change', commonUnits: 1, refusalReasons: [], from: { coverage: { eligibleAnswers: 1, ratedAnswers: 1, ratedAnswerRate: 1 } }, to: { coverage: { eligibleAnswers: 1, ratedAnswers: 1, ratedAnswerRate: 1 } } })
    expect(service.compare('p', query, 'r', 'r3')).toMatchObject({ verdict: null, refusalReasons: ['source-model-changed'] })
  })
  it('rates every answer in each compared period, not only the matched units its scores use', () => {
    service.configure('p', { enabled: true })
    const original = db.select().from(simpleMeasurementDefinitions).get()!
    db.insert(queries).values({ id: 'q2', projectId: 'p', query: 'Acme pricing', createdAt: clock }).run()
    const both = buildSimpleMeasurementDefinition({ capturedAt: clock, identity: { displayName: 'Acme', aliases: [], canonicalDomain: 'https://Acme.Example/', ownedDomains: [] }, country: 'US', language: 'en', location: null, engines: [{ provider: 'openai', requestedModel: 'gpt-test' }], queries: [{ queryId: 'q', queryText: 'Acme reviews', provenance: null }, { queryId: 'q2', queryText: 'Acme pricing', provenance: null }] })
    // 'wide' and 'later' answer both branded queries; 'narrow' answers only the first.
    for (const [runId, queryIds] of [['wide', ['q', 'q2']], ['narrow', ['q']], ['later', ['q', 'q2']]] as const) {
      db.insert(runs).values({ id: runId, projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: clock }).run()
      db.insert(simpleMeasurementDefinitions).values({ ...original, runId, definition: queryIds.length === 2 ? both : original.definition }).run()
      for (const queryId of queryIds) db.insert(querySnapshots).values({ id: `${runId}-${queryId}`, runId, queryId, provider: 'openai', model: 'gpt-test', servedModel: 'gpt-test-v1', answerText: 'Acme is excellent.', citationState: 'cited', createdAt: clock }).run()
    }
    const repository = new SentimentRepository(db)
    const finish = () => {
      for (;;) {
        const work = repository.claim({ owner: 'rated', now: clock, leaseMs: 10_000 })
        if (!work) break
        const input = work.input as { sentences: Array<{ id: string; text: string; start: number; end: number }> }
        repository.completeWork({ workItemId: work.id, owner: 'rated', now: clock, outcome: 'favorable', returnedModel: 'jev-1.13.0', result: { kind: 'classified', outcome: 'favorable', returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 1 }, conclusion: input.sentences.slice(0, 1), complaint: null, confidence: null } })
      }
    }
    for (const runId of ['wide', 'narrow']) service.submit('p', service.preview('p', { runId }).previewToken!, runId, 'test')
    // 'later' admits only its first query, so its second answer stays unadmitted.
    service.submit('p', service.preview('p', { runId: 'later', queryId: 'q' }).previewToken!, 'later', 'test')
    finish()
    const query = { mode: 'auto' as const, queryClass: 'branded' as const, scope: 'project' as const }
    const rated = (coverage: { ratedAnswers?: number; eligibleAnswers?: number; ratedAnswerRate?: number | null }) => [coverage.ratedAnswers, coverage.eligibleAnswers, coverage.ratedAnswerRate]
    const summaryOf = (runId: string) => service.summary('p', { ...query, runId })
    // A period whose second query has no counterpart: both of its answers are rated, 2 of 2.
    const narrowed = service.compare('p', query, 'wide', 'narrow')
    expect(narrowed).toMatchObject({ verdict: null, commonUnits: 1, changedScope: true })
    expect(rated(narrowed.from.coverage)).toEqual([2, 2, 1])
    expect(rated(narrowed.to.coverage)).toEqual([1, 1, 1])
    expect(narrowed.from.coverage).toMatchObject({ selected: 1, judged: 1 })
    expect(narrowed.from.queries.map(row => [row.queryId, ...rated(row.coverage)])).toEqual([['q2', 1, 1, 1], ['q', 1, 1, 1]])
    expect(narrowed.from.breakdowns.filter(row => row.dimension === 'provider').map(row => [row.key, ...rated(row.coverage)])).toEqual([['openai', 2, 2, 1]])
    // A later period that left one answer unadmitted: 2 of 2 before it, 1 of 2 in it.
    const unadmitted = service.compare('p', query, 'wide', 'later')
    expect(unadmitted).toMatchObject({ verdict: null, commonUnits: 1 })
    expect(rated(unadmitted.from.coverage)).toEqual([2, 2, 1])
    expect(rated(unadmitted.to.coverage)).toEqual([1, 2, 0.5])
    // Each period's Rated figure is the one its own summary read shows.
    for (const [period, runId] of [[narrowed.from, 'wide'], [narrowed.to, 'narrow'], [unadmitted.to, 'later']] as const) {
      expect(rated(period.coverage)).toEqual(rated(summaryOf(runId).coverage))
    }
  })
  it('discloses unadmitted assessments and keeps page state bound to the full selection', () => {
    service.configure('p', { enabled: true })
    const stored = db.select().from(simpleMeasurementDefinitions).get()!
    const definition = { ...stored.definition, engines: [...stored.definition.engines, { provider: 'gemini', requestedModel: 'gemini-test' }] }
    db.insert(runs).values({ id: 'wide', projectId: 'p', kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: clock }).run()
    db.insert(simpleMeasurementDefinitions).values({ ...stored, runId: 'wide', definition }).run()
    db.insert(querySnapshots).values({ id: 'wide-openai', runId: 'wide', queryId: 'q', provider: 'openai', model: 'gpt-test', servedModel: 'gpt-v1', answerText: 'Acme is excellent.', citationState: 'cited', createdAt: clock }).run()
    db.insert(querySnapshots).values({ id: 's-gemini', runId: 'wide', queryId: 'q', provider: 'gemini', model: 'gemini-test', servedModel: 'gemini-v1', answerText: 'Acme is excellent.', citationState: 'cited', createdAt: clock }).run()
    const query = { mode: 'auto' as const, queryClass: 'branded' as const, scope: 'project' as const, runId: 'wide' }
    // Before admission both answers are eligible: 0 of 2 rated, not "no answers".
    expect(service.summary('p', query)).toMatchObject({ state: 'not-measured', coverage: { selected: 0, eligibleAssessments: 2, eligibleAnswers: 2, ratedAnswers: 0, ratedAnswerRate: 0 } })
    const preview = service.preview('p', { runId: 'wide', provider: 'openai' })
    service.submit('p', preview.previewToken!, 'partial', 'test')
    const summary = service.summary('p', query)
    expect(summary).toMatchObject({ state: 'partial', provisional: true, coverage: { selected: 1, eligibleAssessments: 2, unadmittedAssessments: 1, eligibleAnswers: 2, ratedAnswers: 0, ratedAnswerRate: 0 } })
    const all = service.preview('p', { runId: 'wide' })
    service.submit('p', all.previewToken!, 'all', 'test')
    const page = service.evidence('p', query, 1)
    expect(page.state).toBe('processing')
    expect(page.nextCursor).not.toBeNull()
    expect(() => service.evidence('p', { ...query, provider: 'gemini' }, 1, page.nextCursor!)).toThrow('Evidence cursor')
  })

  it('exposes default-off settings and null score without secrets', async () => {
    const settings = await request('GET', '/settings', 'read')
    expect(settings.statusCode).toBe(200)
    expect(settings.json()).toMatchObject({ enabled: false, actions: { configure: false, backfill: false } })
    const summary = await request('GET', '', 'read')
    expect(summary.statusCode).toBe(200)
    expect(sentimentSummarySchema.parse(summary.json()).score.favorableRate).toBeNull()
  })
  it('reports an install-wide provider pause in readiness, and a credential refusal blocks backfill until the key changes', async () => {
    service.configure('p', { enabled: true })
    const preview = service.preview('p', { runId: 'r' })
    service.submit('p', preview.previewToken!, 'pause', 'test')
    const repository = new SentimentRepository(db)
    const work = repository.claim({ owner: 'o', now: clock, leaseMs: 60_000 })!
    const attempt = repository.startAttempt({ workItemId: work.id, owner: 'o', requestedModel: 'jev-1.13.0', now: clock })!
    repository.recordProviderRefusal({ workItemId: work.id, owner: 'o', now: clock, dispatchedAt: attempt.dispatchedAt, reason: 'provider-authorization', delayMs: () => 3_600_000, credentialFingerprint: 'refused' })
    const paused = (await request('GET', '/settings')).json()
    expect(paused).toMatchObject({ ready: false, actions: { configure: true, backfill: false } })
    expect(paused.readinessReasons).toEqual([expect.stringMatching(/^provider-authorization: /)])
    expect(service.preview('p', { runId: 'r' }).previewToken).toBeNull()
    expect(repository.dispatchGate({ now: clock, credentialFingerprint: 'rotated' })).toBe('open')
    expect((await request('GET', '/settings')).json()).toMatchObject({ ready: true, readinessReasons: [] })
    const next = repository.claim({ owner: 'o2', now: clock, leaseMs: 60_000 })!
    const second = repository.startAttempt({ workItemId: next.id, owner: 'o2', requestedModel: 'jev-1.13.0', now: clock })!
    repository.recordProviderRefusal({ workItemId: next.id, owner: 'o2', now: clock, dispatchedAt: second.dispatchedAt, reason: 'provider-rate-limit', delayMs: () => 30_000, credentialFingerprint: 'rotated' })
    // A rate limit only delays dispatch, so the install stays ready and says when it resumes.
    expect((await request('GET', '/settings')).json()).toMatchObject({ ready: true, readinessReasons: ['provider-rate-limit: TypeSafe is rate limiting this install. Dispatch resumes after 2026-09-28T00:00:30.000Z.'] })
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
    expect(service.jobList('p').jobs).toEqual([])
  })
  it('prevents a scoped reader from another project and wrong-project jobs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/other/sentiment/settings', headers: { authorization: 'Bearer cnry_scoped' } })
    expect(response.statusCode).toBe(403)
    expect((await request('GET', '/jobs/not-here')).statusCode).toBe(404)
  })
  it('validates non-project scope and reports unmeasured non-brand separately', async () => {
    expect((await request('GET', '?scope=market')).statusCode).toBe(400)
    service.configure('p', { enabled: true })
    const response = await request('GET', '?queryClass=non-brand')
    expect(response.json().state).toBe('not-measured')
    expect(response.json().score.favorableRate).toBeNull()
  })
  it('rejects stale evidence after answer text changes', async () => {
    service.configure('p', { enabled: true })
    const preview = service.preview('p', { runId: 'r' })
    const job = service.submit('p', preview.previewToken!, 'done', 'test')
    const repository = new SentimentRepository(db)
    const work = repository.claim({ owner: 'test', now: clock, leaseMs: 10_000 })!
    repository.completeWork({ workItemId: work.id, owner: 'test', now: clock, outcome: 'favorable', returnedModel: 'jev-1.13.0', result: { kind: 'classified', outcome: 'favorable', returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 1 }, conclusion: [{ id: 's1', text: 'Acme is excellent.', start: 0, end: 18 }], complaint: null, confidence: null } })
    expect(service.job('p', job.id).state).toBe('complete')
    const query = { mode: 'auto' as const, queryClass: 'branded' as const, scope: 'project' as const, runId: 'r' }
    expect(service.summary('p', query).coverage.judged).toBe(1)
    db.$client.prepare('UPDATE query_snapshots SET answer_text = ? WHERE id = ?').run('Acme is awful.', 's')
    expect(service.summary('p', query).coverage.judged).toBe(0)
  })
})
