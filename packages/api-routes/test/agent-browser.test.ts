import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentBrowserChecks, agentBrowserResults, createClient, measurementPlans, measurementPlanVersions, migrate, projects, runs } from '@canonry/canonry-db'
import type { AgentBrowserCheckDto, AgentBrowserCheckScope, AgentBrowserChecksResponseDto, AgentBrowserEffectiveRequest, MeasurementPlanV2 } from '@canonry/canonry-contracts'
import { canonicalMeasurementPlanJson, canonicalMeasurementPlanV2Json, compileMeasurementPlan, normalizeAgentBrowserCheckRequest, serializeRunError } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

// What the route resolves for a check of the project's own site: its stored domains as bare hosts.
const PROJECT_SCOPE: AgentBrowserCheckScope = { property: null, siteHosts: ['example.com', 'example.org'], defaultStartUrl: 'https://example.com/' }

interface Ctx {
  app: ReturnType<typeof Fastify>
  db: ReturnType<typeof createClient>
  tmpDir: string
  projectId: string
  requested: Array<{ runId: string; projectId: string }>
}

let ctx: Ctx

function buildCtx(withHandler = true): Ctx {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-browser-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  const requested: Ctx['requested'] = []
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    ...(withHandler ? { onAgentBrowserCheckRequested: (runId: string, projectId: string) => { requested.push({ runId, projectId }) } } : {}),
  })
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  // Stored the way project upsert stores it: raw, as a full URL with mixed case.
  db.insert(projects).values({
    id: projectId,
    name: 'site',
    displayName: 'Site',
    canonicalDomain: 'https://www.Example.com/',
    ownedDomains: ['example.org'],
    country: 'US',
    language: 'en',
    providers: [],
    locations: [],
    createdAt: now,
    updatedAt: now,
  }).run()
  return { app, db, tmpDir, projectId, requested }
}

beforeEach(() => { ctx = buildCtx() })
afterEach(async () => {
  await ctx.app.close()
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
})

const post = (payload: unknown, app = ctx.app) => app.inject({ method: 'POST', url: '/api/v1/projects/site/agent-browser/checks', payload: payload as Record<string, unknown> })

function seedCheck(createdAt: string, request: AgentBrowserEffectiveRequest, status = 'completed', error: string | null = null): string {
  const runId = crypto.randomUUID()
  ctx.db.insert(runs).values({ id: runId, projectId: ctx.projectId, kind: 'agent-browser-check', status, trigger: 'manual', createdAt, finishedAt: createdAt, error }).run()
  ctx.db.insert(agentBrowserChecks).values({ runId, projectId: ctx.projectId, identityKey: crypto.randomUUID(), request, createdAt }).run()
  return runId
}

function seedResult(runId: string, agent: 'openai' | 'claude' | 'claude-a11y', attempt: number, status: 'passed' | 'failed' | 'errored', verified: boolean): void {
  ctx.db.insert(agentBrowserResults).values({
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    runId,
    agent,
    model: 'm',
    perception: agent === 'claude-a11y' ? 'accessibility-tree' : 'screenshots',
    attempt,
    status,
    verified,
    detail: `${agent} ${attempt}`,
    stop: 'final',
    durationMs: 1000,
    usage: { requests: 1, inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
    createdAt: new Date().toISOString(),
  }).run()
}

describe('POST /projects/:name/agent-browser/checks', () => {
  it('queues a manual run with its normalized request and hands it to the host once', async () => {
    const res = await post({ task: 'Find the pricing page', agents: ['openai'], expect: { urlPath: '/pricing' } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { runId: string; status: string; reused: boolean }
    expect(body).toEqual({ runId: body.runId, status: 'queued', reused: false })
    const run = ctx.db.select().from(runs).where(eq(runs.id, body.runId)).get()
    expect(run).toMatchObject({ kind: 'agent-browser-check', status: 'queued', trigger: 'manual', projectId: ctx.projectId })
    const check = ctx.db.select().from(agentBrowserChecks).where(eq(agentBrowserChecks.runId, body.runId)).get()
    // The default start page comes from the stored domain, reduced to its bare host.
    expect(check?.request).toEqual(normalizeAgentBrowserCheckRequest({ task: 'Find the pricing page', agents: ['openai'], expect: { urlPath: '/pricing' } }, PROJECT_SCOPE))
    expect(ctx.requested).toEqual([{ runId: body.runId, projectId: ctx.projectId }])
  })

  it('joins an identical active check without starting another', async () => {
    const first = (await post({ task: 'Find the pricing page' })).json() as { runId: string }
    const second = await post({ task: ' Find the pricing page ' })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ runId: first.runId, status: 'queued', reused: true })
    expect(ctx.requested).toHaveLength(1)
  })

  it('refuses a different request while a check is active, naming the active run', async () => {
    const first = (await post({ task: 'Find the pricing page' })).json() as { runId: string }
    const res = await post({ task: 'Find the contact form' })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: { code: string; details: { activeRunId: string } } }
    expect(body.error.code).toBe('OPERATION_IN_PROGRESS')
    expect(body.error.details.activeRunId).toBe(first.runId)
    expect(ctx.requested).toHaveLength(1)
  })

  it('accepts a start page on an owned domain and refuses one on another site', async () => {
    expect((await post({ task: 'x', startUrl: 'https://shop.example.org/cart' })).statusCode).toBe(200)
    ctx.db.update(runs).set({ status: 'completed' }).run()
    const offsite = await post({ task: 'x', startUrl: 'https://example.com.evil.io/' })
    expect(offsite.statusCode).toBe(400)
    expect((offsite.json() as { error: { message: string } }).error.message).toBe('"startUrl" must be a page on the project\'s site (example.com, example.org).')
    expect((await post({ task: 'x', startUrl: 'ftp://example.com/' })).statusCode).toBe(400)
  })

  it('refuses a start page carrying a user name or password before storing anything', async () => {
    const res = await post({ task: 'x', startUrl: 'https://user:secret@example.com/' })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { message: string; details: { reason: string } } }).error).toMatchObject({ message: '"startUrl" must not contain a user name or password.', details: { reason: 'credentials-in-url' } })
    expect(ctx.db.select().from(runs).all()).toHaveLength(0)
    expect(ctx.db.select().from(agentBrowserChecks).all()).toHaveLength(0)
  })

  it('refuses a request with no task', async () => {
    const res = await post({ agents: ['openai'] })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    expect(ctx.db.select().from(runs).all()).toHaveLength(0)
  })

  it('answers 422 and creates nothing where no host runs checks', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildCtx(false)
    const res = await post({ task: 'x' })
    expect(res.statusCode).toBe(422)
    expect((res.json() as { error: { code: string } }).error.code).toBe('MISSING_DEPENDENCY')
    expect(ctx.db.select().from(runs).all()).toHaveLength(0)
  })
})

describe('GET /projects/:name/agent-browser/checks', () => {
  it('lists checks newest first with counts from their stored results', async () => {
    const twoAgentsTwice = normalizeAgentBrowserCheckRequest({ task: 'older', agents: ['openai', 'claude-a11y'], repeats: 2 }, PROJECT_SCOPE)
    const older = seedCheck('2026-11-16T10:00:00.000Z', twoAgentsTwice)
    seedResult(older, 'openai', 1, 'passed', true)
    seedResult(older, 'openai', 2, 'passed', false)
    seedResult(older, 'claude-a11y', 1, 'failed', true)
    const newer = seedCheck('2026-11-16T11:00:00.000Z', normalizeAgentBrowserCheckRequest({ task: 'newer' }, PROJECT_SCOPE), 'running')
    seedResult(newer, 'claude', 1, 'errored', false)

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/site/agent-browser/checks' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentBrowserChecksResponseDto
    expect(body.checks.map((c) => [c.runId, c.task, c.status])).toEqual([[newer, 'newer', 'running'], [older, 'older', 'completed']])
    // 2 agents × 2 runs expected; 3 finished.
    expect(body.checks[1]?.summary).toEqual({ expected: 4, results: 3, passed: 2, failed: 1, errored: 0, unverifiedPasses: 1 })
    expect(body.checks[0]?.summary).toEqual({ expected: 3, results: 1, passed: 0, failed: 0, errored: 1, unverifiedPasses: 0 })

    const limited = await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/site/agent-browser/checks?limit=1' })
    expect((limited.json() as AgentBrowserChecksResponseDto).checks.map((c) => c.runId)).toEqual([newer])
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/site/agent-browser/checks?limit=0' })).statusCode).toBe(400)
  })
})

describe('GET /projects/:name/agent-browser/checks/:runId', () => {
  it('returns every agent run in agent then attempt order, with the run error as text', async () => {
    const request = normalizeAgentBrowserCheckRequest({ task: 't', agents: ['openai', 'claude-a11y'], repeats: 2 }, PROJECT_SCOPE)
    const runId = seedCheck('2026-11-16T10:00:00.000Z', request, 'partial', serializeRunError({ message: 'Chrome went away' }))
    seedResult(runId, 'openai', 2, 'failed', true)
    seedResult(runId, 'claude-a11y', 1, 'passed', true)
    seedResult(runId, 'openai', 1, 'errored', false)

    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/site/agent-browser/checks/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as AgentBrowserCheckDto
    expect(body.results.map((r) => [r.agent, r.attempt, r.status, r.perception])).toEqual([
      ['claude-a11y', 1, 'passed', 'accessibility-tree'],
      ['openai', 1, 'errored', 'screenshots'],
      ['openai', 2, 'failed', 'screenshots'],
    ])
    expect(body.error).toBe('Chrome went away')
    expect(body.request).toEqual(request)
    expect(body.summary).toEqual({ expected: 4, results: 3, passed: 1, failed: 1, errored: 1, unverifiedPasses: 0 })
  })

  it('is 404 for an unknown run and for a run of another kind', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/site/agent-browser/checks/${crypto.randomUUID()}` })).statusCode).toBe(404)
    const siteAudit = crypto.randomUUID()
    ctx.db.insert(runs).values({ id: siteAudit, projectId: ctx.projectId, kind: 'site-audit', status: 'completed', trigger: 'manual', createdAt: new Date().toISOString() }).run()
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/projects/site/agent-browser/checks/${siteAudit}` })).statusCode).toBe(404)
  })
})

// A custom portfolio scopes a check to one Property: a Target of the published Advanced
// Measurement plan, in either plan version.
describe('Advanced Measurement portfolios', () => {
  const PUBLISHED_AT = '2026-11-16T09:00:00.000Z'
  // A Property on a host the project does not own (its own hotel site), and one with no URL rule.
  const downtown: MeasurementPlanV2['targets'][number] = {
    stableKey: 'downtown', label: 'Downtown Hotel', aliases: ['Downtown Hotel'],
    urlMatchers: [{ kind: 'exact', url: 'https://downtown-hotel.example/rooms', pathCase: 'insensitive' }],
    mentionNotApplicable: false, discoveryIdentity: null,
  }
  const unlisted: MeasurementPlanV2['targets'][number] = {
    stableKey: 'unlisted', label: 'Unlisted Inn', aliases: ['Unlisted Inn'], urlMatchers: [],
    mentionNotApplicable: false, discoveryIdentity: null,
  }

  /** Publishes revision 3 of a plan; v1 holds only the fixture's URL-backed Properties. */
  function publishPlan(version: 1 | 2): MeasurementPlanV2 {
    const base = measurementPlanV2Fixture()
    const plan = measurementPlanV2Fixture({ targets: [...base.targets, downtown, unlisted] })
    // v1 compiles against the plan's own brand domain, the one its Target URLs are on.
    const legacy = () => compileMeasurementPlan({
      schemaVersion: 1,
      targets: base.targets.map((target) => ({ stableKey: target.stableKey, label: target.label, aliases: target.aliases, urls: target.urlMatchers })),
      groups: [],
      targetQuerySelections: [],
    }, { canonicalDomain: 'northstar.example', ownedDomains: [], brandNames: ['Northstar'], trackedQueries: [], locations: [], defaultContext: null, expectedSnapshots: 1 })
    ctx.db.insert(measurementPlanVersions).values({
      id: 'plan', projectId: ctx.projectId, revision: 3, schemaVersion: version,
      canonicalJson: version === 2 ? canonicalMeasurementPlanV2Json(plan) : canonicalMeasurementPlanJson(legacy()),
      checksum: 'a'.repeat(64), compiledChecksum: version === 2 ? plan.compiledChecksum : null, createdAt: PUBLISHED_AT,
    }).run()
    ctx.db.insert(measurementPlans).values({ projectId: ctx.projectId, activeVersionId: 'plan', createdAt: PUBLISHED_AT, updatedAt: PUBLISHED_AT }).run()
    return plan
  }

  const storedRequest = (runId: string) => ctx.db.select().from(agentBrowserChecks).where(eq(agentBrowserChecks.runId, runId)).get()?.request
  const errorOf = (res: { json: () => unknown }) => (res.json() as { error: { code: string; message: string; details: Record<string, unknown> } }).error

  it.each([1, 2] as const)('checks one Property under plan v%s: its URL rules and the project\'s hosts are the site, its page the start', async (version) => {
    publishPlan(version)
    const res = await post({ task: 'Find the harbor homes', property: 'harbor', agents: ['openai'] })
    expect(res.statusCode).toBe(200)
    const { runId } = res.json() as { runId: string }
    expect(storedRequest(runId)).toEqual(normalizeAgentBrowserCheckRequest({ task: 'Find the harbor homes', property: 'harbor', agents: ['openai'] }, {
      property: { key: 'harbor', label: 'Harbor Homes', planRevision: 3 },
      siteHosts: ['example.com', 'example.org', 'northstar.example'],
      defaultStartUrl: 'https://northstar.example/locations/harbor',
    }))
    expect(ctx.requested).toEqual([{ runId, projectId: ctx.projectId }])
  })

  it('starts on a Property\'s own site, which counts as the site only for that Property', async () => {
    publishPlan(2)
    const res = await post({ task: 'Book a room', property: 'downtown' })
    expect(res.statusCode).toBe(200)
    const request = storedRequest((res.json() as { runId: string }).runId)
    expect(request?.startUrl).toBe('https://downtown-hotel.example/rooms')
    expect(request?.siteHosts).toEqual(['downtown-hotel.example', 'example.com', 'example.org'])
    ctx.db.update(runs).set({ status: 'completed' }).run()
    // Another page of the Property's site may start it; without the Property that site is off-site.
    expect((await post({ task: 'Book a room', property: 'downtown', startUrl: 'https://downtown-hotel.example/spa' })).statusCode).toBe(200)
    ctx.db.update(runs).set({ status: 'completed' }).run()
    const offsite = await post({ task: 'Book a room', startUrl: 'https://downtown-hotel.example/spa' })
    expect(offsite.statusCode).toBe(400)
    expect(errorOf(offsite).message).toBe('"startUrl" must be a page on the project\'s site (example.com, example.org).')
    const wrongSite = await post({ task: 'Book a room', property: 'harbor', startUrl: 'https://downtown-hotel.example/spa' })
    expect(errorOf(wrongSite).message).toBe('"startUrl" must be a page on Property "Harbor Homes"\'s site or the project\'s (example.com, example.org, northstar.example).')
  })

  it('needs a start page for a Property with no URL rule, and then uses the project\'s hosts', async () => {
    publishPlan(2)
    const missing = await post({ task: 'Find the inn', property: 'unlisted' })
    expect(missing.statusCode).toBe(400)
    expect(errorOf(missing)).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Property "Unlisted Inn" has no URL in the published measurement plan. Pass "startUrl".', details: { reason: 'property-without-url', property: 'unlisted' } })
    const given = await post({ task: 'Find the inn', property: 'unlisted', startUrl: 'https://example.com/inns/unlisted' })
    expect(given.statusCode).toBe(200)
    expect(storedRequest((given.json() as { runId: string }).runId)).toMatchObject({
      property: { key: 'unlisted', label: 'Unlisted Inn', planRevision: 3 },
      siteHosts: ['example.com', 'example.org'],
      startUrl: 'https://example.com/inns/unlisted',
    })
  })

  it('refuses a Property the published plan does not have, naming the ones it does, and creates nothing', async () => {
    publishPlan(2)
    const res = await post({ task: 'x', property: 'lakeside' })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res)).toMatchObject({
      message: 'Property "lakeside" is not in the published measurement plan.',
      // In the published plan's canonical order.
      details: { reason: 'unknown-property', property: 'lakeside', properties: ['bayside', 'downtown', 'harbor', 'unlisted'] },
    })
    expect(ctx.db.select().from(runs).all()).toHaveLength(0)
  })

  it('refuses a Property check on a project with no published plan', async () => {
    const res = await post({ task: 'x', property: 'harbor' })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res)).toMatchObject({ message: 'Checking a Property needs a published Advanced Measurement plan.', details: { reason: 'no-measurement-plan' } })
    expect(ctx.db.select().from(runs).all()).toHaveLength(0)
  })

  it('lists each check with its Property and filters by the key recorded on the check', async () => {
    const harborScope: AgentBrowserCheckScope = { property: { key: 'harbor', label: 'Harbor Homes', planRevision: 3 }, siteHosts: ['example.com', 'northstar.example'], defaultStartUrl: 'https://northstar.example/locations/harbor' }
    // No plan is published now: a check of a Property a later plan dropped stays listed under it.
    const harbor = seedCheck('2026-11-16T10:00:00.000Z', normalizeAgentBrowserCheckRequest({ task: 'harbor task' }, harborScope))
    const site = seedCheck('2026-11-16T11:00:00.000Z', normalizeAgentBrowserCheckRequest({ task: 'site task' }, PROJECT_SCOPE))
    const all = (await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/site/agent-browser/checks' })).json() as AgentBrowserChecksResponseDto
    expect(all.checks.map((c) => [c.runId, c.property])).toEqual([[site, null], [harbor, { key: 'harbor', label: 'Harbor Homes' }]])
    const only = (await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/site/agent-browser/checks?property=harbor' })).json() as AgentBrowserChecksResponseDto
    expect(only.checks.map((c) => c.runId)).toEqual([harbor])
    const none = (await ctx.app.inject({ method: 'GET', url: '/api/v1/projects/site/agent-browser/checks?property=bayside' })).json() as AgentBrowserChecksResponseDto
    expect(none.checks).toEqual([])
  })
})
