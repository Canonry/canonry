import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  buildProviderRunError,
  buildSimpleMeasurementDefinition,
  canonicalMeasurementPlanV2Json,
  PROVIDER_ACCOUNT_FAILURE_STREAK,
  projectSetupDtoSchema,
  RunKinds,
  RunStatuses,
  RunTriggers,
  serializeRunError,
  withSkippedProviders,
  type ProjectSetupDto,
  type RunDetailDto,
  type RunStatus,
  type SiteAuditEffectiveRequest,
} from '@canonry/canonry-contracts'
import {
  apiKeys,
  auditLog,
  createClient,
  measurementPlanDrafts,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  siteAuditSnapshots,
  siteCrawlAttempts,
  siteCrawlRunRequests,
} from '@canonry/canonry-db'
import { apiRoutes, captureSimpleMeasurementDefinition } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { HARBOR_CONTEXT, measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const AT = '2026-09-01T12:00:00.000Z'
/** `AT` plus whole minutes, so seeded runs order by creation. */
const at = (minute: number) => new Date(Date.parse(AT) + minute * 60_000).toISOString()

const AUTH = '[provider-openai] 401 Incorrect API key provided'
const GEMINI_BAD_KEY = `[provider-gemini] ${JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } })}`
const FIRST_SCAN_REQUEST: SiteAuditEffectiveRequest = {
  schemaVersion: 3, sitemapUrl: null, maxPages: 100, maxEdges: null, maxDepth: null,
  checkDeadLinks: false, includeGeo: false, includeAgentSkills: true,
}
const TRACKED = { total: 3, nonBrand: 2, branded: 1, unclassified: 0 }
const NOT_STARTED_SCAN = { state: 'not_started', runId: null, startedAt: null, finishedAt: null, progress: null, result: null, error: null }
const READY_CHECK = {
  state: 'not_started', runId: null, startedAt: null, finishedAt: null, mode: 'simple', blockedBy: null,
  engines: ['gemini', 'openai'], queries: TRACKED, progress: null, providerFailures: null, result: null, error: null, failedEngines: null,
}

const FINISHED = new Set<RunStatus>([RunStatuses.completed, RunStatuses.partial, RunStatuses.failed, RunStatuses.cancelled])

async function harness(options: { skipAuth?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-project-setup-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  let available = ['openai', 'gemini']
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: options.skipAuth ?? true,
    getRunnableProviderNames: () => available,
    getEffectiveProviderModels: () => ({ openai: 'gpt-5', gemini: 'gemini-2.5-flash' }),
  })
  await app.ready()
  onTestFinished(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  db.insert(projects).values({
    id: 'northstar', name: 'northstar', displayName: 'Northstar', canonicalDomain: 'northstar.example',
    country: 'US', language: 'en', providers: ['openai', 'gemini'],
    locations: [HARBOR_CONTEXT], defaultLocation: HARBOR_CONTEXT.label, createdAt: AT, updatedAt: AT,
  }).run()
  db.insert(queries).values([
    { id: 'generic-a', projectId: 'northstar', query: 'best nearby service', createdAt: AT },
    { id: 'generic-b', projectId: 'northstar', query: 'find a local service', createdAt: AT },
    { id: 'branded', projectId: 'northstar', query: 'is Northstar reliable', createdAt: AT },
  ]).run()

  /** A run of one kind, created at `minute`; a finished one ends a minute later. */
  const seedRun = (kind: typeof RunKinds['site-audit'] | typeof RunKinds['answer-visibility']) =>
    (id: string, status: RunStatus, minute: number, extra: Partial<typeof runs.$inferInsert> = {}) => {
      db.insert(runs).values({
        id, projectId: 'northstar', kind, status, trigger: RunTriggers.manual, createdAt: at(minute),
        ...(status === RunStatuses.queued ? {} : { startedAt: at(minute) }),
        ...(FINISHED.has(status) ? { finishedAt: at(minute + 1) } : {}),
        ...extra,
      }).run()
    }
  /** One stored answer; whether it mentions Northstar comes from its text, as every reader decides it. */
  const answer = (runId: string, queryId: string, provider: string, cited: boolean, answerText: string) => {
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId, queryId, provider, citationState: cited ? 'cited' : 'not-cited', answerText, createdAt: AT,
    }).run()
  }
  const scorecard = (runId: string, aggregateScore: number, pagesAudited: number) => {
    db.insert(siteAuditSnapshots).values({
      id: crypto.randomUUID(), projectId: 'northstar', runId, sitemapUrl: 'https://northstar.example/sitemap.xml',
      auditedAt: AT, aggregateScore, pagesDiscovered: 75, pagesAudited, createdAt: AT,
    }).run()
  }
  const read = async (name = 'northstar', headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/v1/projects/${name}/setup`, headers })
  const setup = async (): Promise<ProjectSetupDto> => {
    const response = await read()
    expect(response.statusCode, response.body).toBe(200)
    // Strict: the response carries exactly the contract's fields.
    return projectSetupDtoSchema.parse(response.json())
  }
  return {
    app, db, read, setup, answer, scorecard,
    scan: seedRun(RunKinds['site-audit']),
    check: seedRun(RunKinds['answer-visibility']),
    setAvailable: (value: string[]) => { available = value },
  }
}

describe('GET /projects/:name/setup', () => {
  it('reads a project with no runs: both tracks not started, the check ready, the scan first, and nothing written', async () => {
    const { db, setup } = await harness()
    expect(await setup()).toEqual({
      project: { name: 'northstar', displayName: 'Northstar', canonicalDomain: 'northstar.example' },
      complete: false,
      firstResultAt: null,
      nextAction: 'run_agent_readiness',
      tracks: { agentReadiness: NOT_STARTED_SCAN, aiVisibility: READY_CHECK },
    })
    expect(db.select().from(runs).all()).toEqual([])
    expect(db.select().from(auditLog).all()).toEqual([])
  })

  it('reports a queued and a running scan by its latest crawl attempt and the page budget it was started with', async () => {
    const { db, setup, scan } = await harness()
    scan('scan', RunStatuses.queued, 0)
    db.insert(siteCrawlRunRequests).values({ runId: 'scan', projectId: 'northstar', identityKey: 'first-scan', effectiveOptions: FIRST_SCAN_REQUEST, createdAt: at(0) }).run()
    expect((await setup()).tracks.agentReadiness).toEqual({
      state: 'queued', runId: 'scan', startedAt: null, finishedAt: null,
      progress: { phase: 'queued', pagesFound: null, pagesChecked: 0, pageLimit: 100, linksFound: null, pagesFailed: null },
      result: null, error: null,
    })

    db.update(runs).set({ status: RunStatuses.running, startedAt: at(1) }).where(eq(runs.id, 'scan')).run()
    db.insert(siteCrawlAttempts).values({ id: 'attempt-1', projectId: 'northstar', runId: 'scan', attemptNumber: 1, state: 'running', pagesDiscovered: 40, createdAt: at(1), updatedAt: at(1) }).run()
    expect((await setup()).tracks.agentReadiness.progress).toEqual({ phase: 'discovering', pagesFound: 40, pagesChecked: 0, pageLimit: 100, linksFound: 0, pagesFailed: 0 })

    // A retry is a newer attempt of the same run; its counters are the ones reported.
    db.insert(siteCrawlAttempts).values({
      id: 'attempt-2', projectId: 'northstar', runId: 'scan', attemptNumber: 2, state: 'running',
      pagesDiscovered: 75, pagesFetched: 10, pagesErrored: 1, edgesDiscovered: 414, createdAt: at(2), updatedAt: at(2),
    }).run()
    expect((await setup()).tracks.agentReadiness).toEqual({
      state: 'running', runId: 'scan', startedAt: at(1), finishedAt: null,
      progress: { phase: 'checking', pagesFound: 75, pagesChecked: 10, pageLimit: 100, linksFound: 414, pagesFailed: 1 },
      result: null, error: null,
    })
  })

  it('reports a finished scan by its own scorecard, a scan that scored no page without a score, and a failed scan by its stored reason', async () => {
    const { setup, scan, scorecard } = await harness()
    scan('complete-scan', RunStatuses.completed, 0)
    scorecard('complete-scan', 72, 58)
    expect((await setup()).tracks.agentReadiness).toEqual({
      state: 'completed', runId: 'complete-scan', startedAt: at(0), finishedAt: at(1), progress: null, result: { score: 72, pagesScored: 58 }, error: null,
    })

    // A partial crawl that stopped before scoring a page stores no scorecard: no score, never 0.
    scan('partial-scan', RunStatuses.partial, 10)
    expect((await setup()).tracks.agentReadiness).toEqual({
      state: 'partial', runId: 'partial-scan', startedAt: at(10), finishedAt: at(11), progress: null, result: { score: null, pagesScored: 0 }, error: null,
    })

    scan('failed-scan', RunStatuses.failed, 20, { error: 'Sitemap fetch failed: HTTP 503' })
    expect((await setup()).tracks.agentReadiness).toEqual({
      state: 'failed', runId: 'failed-scan', startedAt: at(20), finishedAt: at(21), progress: null, result: null, error: 'Sitemap fetch failed: HTTP 503',
    })

    scan('cancelled-scan', RunStatuses.cancelled, 30, { error: serializeRunError({ message: 'Cancelled by user' }) })
    expect((await setup()).tracks.agentReadiness).toEqual({
      state: 'cancelled', runId: 'cancelled-scan', startedAt: at(30), finishedAt: at(31), progress: null, result: null, error: null,
    })
  })

  it('blocks the first check by the run preview\'s readiness: no engine, no queries, then an edited unpublished Advanced draft', async () => {
    const { db, setup, scan, setAvailable } = await harness()
    scan('scan', RunStatuses.completed, 0)

    setAvailable([])
    const noEngine = await setup()
    expect(noEngine.tracks.aiVisibility).toEqual({ ...READY_CHECK, blockedBy: 'no_engine', engines: [] })
    expect(noEngine.nextAction).toBe('connect_engine')

    setAvailable(['openai', 'gemini'])
    db.delete(queries).where(eq(queries.projectId, 'northstar')).run()
    const noQueries = await setup()
    expect(noQueries.tracks.aiVisibility).toEqual({
      ...READY_CHECK, blockedBy: 'no_queries', engines: [], queries: { total: 0, nonBrand: 0, branded: 0, unclassified: 0 },
    })
    expect(noQueries.nextAction).toBe('add_queries')

    // With neither, the engine comes first. The preview reports the missing
    // queries first, but nothing can run until an engine is connected.
    setAvailable([])
    const neither = await setup()
    expect({ blockedBy: neither.tracks.aiVisibility.blockedBy, nextAction: neither.nextAction })
      .toEqual({ blockedBy: 'no_engine', nextAction: 'connect_engine' })
    setAvailable(['openai', 'gemini'])

    // ETag version 2: an operator has edited the draft, so a manual check would measure an unpublished plan.
    db.insert(measurementPlanDrafts).values({
      id: 'draft', projectId: 'northstar', etagVersion: 2, createdBy: 'test', updatedBy: 'test', createdAt: AT, updatedAt: AT,
      authoringJson: JSON.stringify({ defaultContext: { providers: ['openai'], locations: [] }, targets: [], assignments: [], groups: [] }),
    }).run()
    const unpublished = await setup()
    expect(unpublished.tracks.aiVisibility).toEqual({
      ...READY_CHECK, mode: 'advanced', blockedBy: 'plan_unpublished', engines: [], queries: { total: 0, nonBrand: 0, branded: 0, unclassified: 0 },
    })
    expect(unpublished.nextAction).toBe('publish_plan')
  })

  it('sends a project whose engines all keep failing on their accounts to repair, after a cancelled check too', async () => {
    const { db, setup, scan } = await harness()
    db.update(projects).set({ providers: ['openai'] }).where(eq(projects.id, 'northstar')).run()
    scan('scan', RunStatuses.completed, 0)
    // The streak is recent: a held engine is called again only a day after its newest failure.
    const now = Date.now()
    for (let index = 0; index < PROVIDER_ACCOUNT_FAILURE_STREAK; index++) {
      db.insert(runs).values({
        id: `failed-${index}`, projectId: 'northstar', kind: RunKinds['answer-visibility'], status: RunStatuses.failed,
        trigger: RunTriggers.scheduled, error: serializeRunError(buildProviderRunError([['openai', AUTH]])),
        createdAt: new Date(now - (30 - index) * 60_000).toISOString(),
      }).run()
    }
    const cancelledAt = new Date(now - 60_000).toISOString()
    db.insert(runs).values({
      id: 'cancelled-check', projectId: 'northstar', kind: RunKinds['answer-visibility'], status: RunStatuses.cancelled,
      trigger: RunTriggers.manual, createdAt: cancelledAt, finishedAt: cancelledAt,
    }).run()
    const body = await setup()
    expect(body.tracks.aiVisibility).toEqual({
      ...READY_CHECK, state: 'cancelled', runId: 'cancelled-check', finishedAt: cancelledAt, blockedBy: 'engines_failing', engines: [],
    })
    expect(body.nextAction).toBe('repair_ai_visibility')
  })

  it('reports a running check by its saved answers against the answers it planned, its failing engines and the engines it calls', async () => {
    const { db, setup, scan, check, answer } = await harness()
    scan('scan', RunStatuses.completed, 0)
    check('check', RunStatuses.queued, 5)
    // Queued: nothing planned yet, and the engines are those a new check would call.
    expect((await setup()).tracks.aiVisibility).toEqual({ ...READY_CHECK, state: 'queued', runId: 'check', progress: { answersSaved: 0, answersPlanned: null } })

    const failures = { gemini: { message: 'Gemini rate limit reached.', failedQueries: 1, stopped: false } }
    db.update(runs).set({
      status: RunStatuses.running, startedAt: at(6), plannedAnswers: 3, providerFailures: failures,
      skippedProviders: { openai: { code: 'PROVIDER_AUTH', consecutiveRuns: 10, since: AT, latestRunId: 'older', retryAfter: at(1440) } },
    }).where(eq(runs.id, 'check')).run()
    captureSimpleMeasurementDefinition(db, {
      projectId: 'northstar', runId: 'check',
      definition: buildSimpleMeasurementDefinition({
        capturedAt: at(6), identity: { displayName: 'Northstar', aliases: [], canonicalDomain: 'northstar.example', ownedDomains: [] },
        country: 'US', language: 'en', location: HARBOR_CONTEXT,
        engines: [{ provider: 'gemini', requestedModel: 'gemini-2.5-flash' }, { provider: 'openai', requestedModel: 'gpt-5' }],
        queries: [{ queryId: 'generic-a', queryText: 'best nearby service', provenance: null }],
      }),
    })
    answer('check', 'generic-a', 'gemini', true, 'Northstar is a top pick.')
    answer('check', 'generic-b', 'gemini', false, 'Try a local directory.')
    // The check calls gemini only: it skips openai, which its frozen roster lists.
    expect((await setup()).tracks.aiVisibility).toEqual({
      ...READY_CHECK, state: 'running', runId: 'check', startedAt: at(6), engines: ['gemini'],
      progress: { answersSaved: 2, answersPlanned: 3 }, providerFailures: failures,
    })
  })

  it('reports a finished check with non-brand and branded counts on their own denominators, exactly as the run detail does', async () => {
    const { app, setup, check, answer } = await harness()
    check('check', RunStatuses.completed, 5)
    // generic-a: gemini cites and mentions, openai neither; generic-b: openai mentions only;
    // branded: both mention, gemini cites.
    answer('check', 'generic-a', 'gemini', true, 'Northstar is a top pick.')
    answer('check', 'generic-a', 'openai', false, 'Several services operate nearby.')
    answer('check', 'generic-b', 'openai', false, 'Northstar has local staff.')
    answer('check', 'generic-b', 'gemini', false, 'Search a local directory.')
    answer('check', 'branded', 'gemini', true, 'Northstar is reliable.')
    answer('check', 'branded', 'openai', false, 'Northstar gets good reviews.')
    const completed = await setup()
    expect(completed.tracks.aiVisibility).toEqual({
      ...READY_CHECK, state: 'completed', runId: 'check', startedAt: at(5), finishedAt: at(6),
      result: {
        answers: 6,
        engines: 2,
        queryCounts: { totalQueries: 3, citedQueries: 2, mentionedQueries: 3, citationNotMeasuredQueries: 0 },
        queryCountsByClass: {
          nonBrand: { totalQueries: 2, citedQueries: 1, mentionedQueries: 2, citationNotMeasuredQueries: 0 },
          branded: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
          unclassifiedQueries: 0,
        },
      },
    })
    const detail = (await app.inject({ method: 'GET', url: '/api/v1/runs/check' })).json<RunDetailDto>()
    expect({ queryCounts: detail.queryCounts, queryCountsByClass: detail.queryCountsByClass }).toEqual({
      queryCounts: completed.tracks.aiVisibility.result?.queryCounts,
      queryCountsByClass: completed.tracks.aiVisibility.result?.queryCountsByClass,
    })
  })

  it('reports a partial check by what it saved, and a failed check by its error as one line and engine by engine', async () => {
    const { db, setup, check, answer } = await harness()
    check('partial-check', RunStatuses.partial, 0, { error: serializeRunError(buildProviderRunError([['openai', AUTH]])) })
    answer('partial-check', 'generic-a', 'gemini', true, 'Northstar is a top pick.')
    expect((await setup()).tracks.aiVisibility).toEqual({
      ...READY_CHECK, state: 'partial', runId: 'partial-check', startedAt: at(0), finishedAt: at(1),
      result: {
        answers: 1,
        engines: 1,
        queryCounts: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
        queryCountsByClass: {
          nonBrand: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
          branded: { totalQueries: 0, citedQueries: 0, mentionedQueries: 0, citationNotMeasuredQueries: 0 },
          unclassifiedQueries: 0,
        },
      },
    })

    check('failed-check', RunStatuses.failed, 10, { error: serializeRunError(buildProviderRunError([['gemini', GEMINI_BAD_KEY], ['openai', AUTH]])) })
    expect((await setup()).tracks.aiVisibility).toEqual({
      ...READY_CHECK, state: 'failed', runId: 'failed-check', startedAt: at(10), finishedAt: at(11),
      error: 'gemini: API key not valid. Please pass a valid API key. • openai: 401 Incorrect API key provided',
      // Each engine keeps the failure kind classified when it failed, so a client can say what to do.
      failedEngines: [
        { provider: 'gemini', code: 'PROVIDER_AUTH', message: 'API key not valid. Please pass a valid API key.', skipped: false },
        { provider: 'openai', code: 'PROVIDER_AUTH', message: '401 Incorrect API key provided', skipped: false },
      ],
    })

    // An engine out of credit, and one the check skipped because it kept failing on its account.
    const outOfCredit = buildProviderRunError([['openrouter', 'OpenRouter request failed (HTTP 402): Insufficient credits']])
    const skipped = withSkippedProviders(outOfCredit, { gemini: { code: 'PROVIDER_AUTH', consecutiveRuns: 3, since: at(0), latestRunId: 'older-check', retryAfter: at(30) } })
    db.update(runs).set({ error: serializeRunError(skipped) }).where(eq(runs.id, 'failed-check')).run()
    const failedEngines = (await setup()).tracks.aiVisibility.failedEngines
    expect(failedEngines?.map(engine => [engine.provider, engine.code, engine.skipped])).toEqual([
      ['gemini', 'PROVIDER_AUTH', true],
      ['openrouter', 'PROVIDER_BILLING', false],
    ])
    expect(failedEngines?.[1]?.message).toBe('OpenRouter request failed (HTTP 402): Insufficient credits')

    // An error stored as plain text before errors were structured reads as that text, and names no engine.
    db.update(runs).set({ error: 'Server restarted while run was in progress' }).where(eq(runs.id, 'failed-check')).run()
    const plain = (await setup()).tracks.aiVisibility
    expect([plain.error, plain.failedEngines]).toEqual(['Server restarted while run was in progress', null])
  })

  it.each([
    { scan: null, check: null, next: 'run_agent_readiness', complete: false },
    { scan: RunStatuses.cancelled, check: RunStatuses.completed, next: 'run_agent_readiness', complete: false },
    { scan: RunStatuses.failed, check: RunStatuses.running, next: 'retry_agent_readiness', complete: false },
    // The check never waits for the scan: neither track gates the other.
    { scan: RunStatuses.running, check: null, next: 'run_ai_visibility', complete: false },
    { scan: RunStatuses.completed, check: RunStatuses.cancelled, next: 'run_ai_visibility', complete: false },
    { scan: RunStatuses.partial, check: RunStatuses.failed, next: 'repair_ai_visibility', complete: false },
    { scan: RunStatuses.running, check: RunStatuses.running, next: 'wait', complete: false },
    { scan: RunStatuses.queued, check: RunStatuses.partial, next: 'wait', complete: false },
    // A first check in progress waits; setup is not complete before its result.
    { scan: RunStatuses.completed, check: RunStatuses.queued, next: 'wait', complete: false },
    { scan: RunStatuses.completed, check: RunStatuses.completed, next: 'open_project', complete: true },
    { scan: RunStatuses.partial, check: RunStatuses.partial, next: 'open_project', complete: true },
  ])('suggests $next for a $scan scan and a $check check', async ({ scan: scanStatus, check: checkStatus, next, complete }) => {
    const { setup, scan, check } = await harness()
    if (scanStatus) scan('scan', scanStatus, 0)
    if (checkStatus) check('check', checkStatus, 0)
    const body = await setup()
    expect({ nextAction: body.nextAction, complete: body.complete }).toEqual({ nextAction: next, complete })
  })

  it('stays complete while a newer check runs once both tracks have a result', async () => {
    const { setup, scan, check } = await harness()
    scan('scan', RunStatuses.completed, 0)
    check('first-check', RunStatuses.partial, 10)
    check('newer-check', RunStatuses.queued, 20)
    // An older failed check sits between them in history and changes nothing.
    check('failed-check', RunStatuses.failed, 5)
    const body = await setup()
    expect({ complete: body.complete, nextAction: body.nextAction, checkState: body.tracks.aiVisibility.state })
      .toEqual({ complete: true, nextAction: 'wait', checkState: 'queued' })
  })

  it('is not complete when a track only ever failed', async () => {
    const { setup, scan, check } = await harness()
    scan('scan', RunStatuses.completed, 0)
    check('failed-check', RunStatuses.failed, 10)
    expect((await setup()).complete).toBe(false)
  })

  it('dates the first result by the earliest finished completed or partial run of either kind', async () => {
    const { setup, scan, check } = await harness()
    // A failure is not a result, however early it finished.
    scan('failed-scan', RunStatuses.failed, 0)
    // Created first, finished last.
    scan('slow-scan', RunStatuses.completed, 10, { finishedAt: at(50) })
    check('quick-check', RunStatuses.partial, 20, { finishedAt: at(30) })
    check('later-check', RunStatuses.completed, 40, { finishedAt: at(45) })
    expect((await setup()).firstResultAt).toBe(at(30))
  })

  it('reads a custom portfolio by its published plan: plan classes, frozen engines, planned answers and per-class results', async () => {
    const { app, db, setup, scan, scorecard, answer } = await harness()
    db.delete(queries).where(eq(queries.projectId, 'northstar')).run()
    // q-nearby and q-brand are the plan's (non-brand and branded); q-extra is tracked but assigned to no Property.
    db.insert(queries).values([
      { id: 'q-nearby', projectId: 'northstar', query: 'homes near harbor', createdAt: AT },
      { id: 'q-brand', projectId: 'northstar', query: 'northstar reviews', createdAt: AT },
      { id: 'q-extra', projectId: 'northstar', query: 'harbor moving services', createdAt: AT },
    ]).run()
    const plan = measurementPlanV2Fixture()
    db.insert(measurementPlanVersions).values({
      id: 'v1', projectId: 'northstar', revision: 1, schemaVersion: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan),
      checksum: 'a'.repeat(64), compiledChecksum: plan.compiledChecksum, createdAt: AT,
    }).run()
    db.insert(measurementPlans).values({ projectId: 'northstar', activeVersionId: 'v1', createdAt: AT, updatedAt: AT }).run()
    scan('scan', RunStatuses.completed, 0)
    scorecard('scan', 64, 40)
    const portfolioQueries = { total: 3, nonBrand: 1, branded: 1, unclassified: 1 }
    const ready = await setup()
    expect(ready.tracks.aiVisibility).toEqual({ ...READY_CHECK, mode: 'advanced', queries: portfolioQueries })
    expect(ready.nextAction).toBe('run_ai_visibility')

    // Queued through the launch route, so the run freezes the plan's slots and engines.
    const launched = await app.inject({ method: 'POST', url: '/api/v1/projects/northstar/runs', payload: {} })
    expect(launched.statusCode, launched.body).toBe(201)
    const runId = launched.json<{ id: string }>().id
    db.update(runs).set({ status: RunStatuses.running, startedAt: at(40), plannedAnswers: 4 }).where(eq(runs.id, runId)).run()
    answer(runId, 'q-nearby', 'gemini', true, 'Northstar Harbor Homes is close by.')
    const running = await setup()
    expect(running.tracks.aiVisibility).toEqual({
      ...READY_CHECK, mode: 'advanced', queries: portfolioQueries, state: 'running', runId, startedAt: at(40),
      engines: ['gemini', 'openai'], progress: { answersSaved: 1, answersPlanned: 4 },
    })
    expect(running.nextAction).toBe('wait')

    answer(runId, 'q-nearby', 'openai', false, 'Try a harbor realtor.')
    answer(runId, 'q-brand', 'gemini', false, 'Northstar reviews are positive.')
    answer(runId, 'q-brand', 'openai', false, 'Reviews vary by office.')
    db.update(runs).set({ status: RunStatuses.completed, finishedAt: at(50) }).where(eq(runs.id, runId)).run()
    const done = await setup()
    expect(done).toEqual({
      project: { name: 'northstar', displayName: 'Northstar', canonicalDomain: 'northstar.example' },
      complete: true,
      firstResultAt: at(1),
      nextAction: 'open_project',
      tracks: {
        agentReadiness: { state: 'completed', runId: 'scan', startedAt: at(0), finishedAt: at(1), progress: null, result: { score: 64, pagesScored: 40 }, error: null },
        aiVisibility: {
          ...READY_CHECK, mode: 'advanced', queries: portfolioQueries, state: 'completed', runId, startedAt: at(40), finishedAt: at(50),
          result: {
            answers: 4,
            engines: 2,
            queryCounts: { totalQueries: 2, citedQueries: 1, mentionedQueries: 2, citationNotMeasuredQueries: 0 },
            // Classes from the plan's assignments, never from the query text.
            queryCountsByClass: {
              nonBrand: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
              branded: { totalQueries: 1, citedQueries: 0, mentionedQueries: 1, citationNotMeasuredQueries: 0 },
              unclassifiedQueries: 0,
            },
          },
        },
      },
    })
  })

  it('serves read-only and project-scoped keys like other project reads, and refuses an unknown project', async () => {
    const { db, read } = await harness({ skipAuth: false })
    db.insert(projects).values({ id: 'other', name: 'other', displayName: 'Other', canonicalDomain: 'other.example', country: 'US', language: 'en', createdAt: AT, updatedAt: AT }).run()
    const scoped = 'cnry_setup_scoped_read'
    const instance = 'cnry_setup_instance_read'
    for (const [key, projectId] of [[scoped, 'northstar'], [instance, null]] as const) {
      db.insert(apiKeys).values({ id: crypto.randomUUID(), name: key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, 9), scopes: ['read'], projectId, createdAt: AT }).run()
    }
    expect((await read('northstar', { authorization: `Bearer ${scoped}` })).statusCode).toBe(200)
    expect((await read('other', { authorization: `Bearer ${scoped}` })).statusCode).toBe(403)
    const missing = await read('missing', { authorization: `Bearer ${instance}` })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })
})
