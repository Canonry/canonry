import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, measurementPlans, measurementPlanVersions, measurementQueryTemplates, migrate, projects, queries, researchRuns, runs } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { canonicalMeasurementPlanJson, canonicalMeasurementPlanV2Json, compileMeasurementPlan, ResearchRunStatuses } from '@ainyc/canonry-contracts'
import { apiRoutes, type ApiRoutesOptions } from '../src/index.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))

function harness(options: Partial<ApiRoutesOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-'))
  const db = createClient(path.join(dir, 'test.db')); migrate(db)
  const now = new Date().toISOString()
  for (const name of ['alpha', 'beta']) db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.com`, country: 'US', language: 'en', providers: ['openai'], locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York', createdAt: now, updatedAt: now }).run()
  const app = Fastify(); const requested: string[] = []
  app.register(apiRoutes, { db, skipAuth: true, onResearchRunRequested: id => requested.push(id), providerSummary: [{ name: 'openai', configured: true }], providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-4.1', knownModels: [{ id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' }], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model' }], ...options } satisfies ApiRoutesOptions)
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { app, db, requested }
}

function publishResearchScopePlan(db: ReturnType<typeof harness>['db']) {
  const plan = measurementPlanV2Fixture({
    reportingScopes: [{
      stableKey: 'north-market',
      label: 'North market',
      kind: 'market',
      usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' }],
    }],
  })
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId, projectId: 'alpha', revision: 1, canonicalJson, checksum: '1'.repeat(64),
    schemaVersion: 2, compiledChecksum: plan.compiledChecksum, createdAt: new Date().toISOString(),
  }).run()
  db.insert(measurementPlans).values({
    projectId: 'alpha', activeVersionId: versionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run()
  return plan
}

describe('research routes', () => {
  it('persists an isolated batch, lists/details it, and protects retry/project boundaries', async () => {
    const { app, db, requested } = harness()
    const payload = { queries: ['best solar installer', 'solar cost'], provider: 'openai', model: 'gpt-4.1', location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' }, idempotencyKey: 'retry-1' }
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })
    expect(created.statusCode).toBe(202); const body = created.json(); expect(body.queries).toHaveLength(2); expect(body.queries[0]).toMatchObject({ namedCompetitors: [], citedCompetitorDomains: [] }); expect(requested).toHaveLength(1)
    expect(db.select().from(queries).all()).toHaveLength(0); expect(db.select().from(runs).all()).toHaveLength(0)
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })).json().runs).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/beta/research/runs/${body.id}` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })).statusCode).toBe(200)
    expect(requested).toEqual([body.id, body.id])
    db.update(researchRuns).set({ status: ResearchRunStatuses.running }).run()
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })).statusCode).toBe(200)
    expect(requested).toEqual([body.id, body.id])
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, queries: ['different'] } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, queries: ['same', 'same'] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, provider: 'claude' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, model: 'not-a-gpt-model' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, idempotencyKey: undefined, location: { ...payload.location, city: 'Boston' } } })).statusCode).toBe(400)
    expect(db.select().from(researchRuns).all()).toHaveLength(1)
  })

  it.each([
    ['same query', 'same query'],
    ['same query', 'SAME QUERY'],
    ['  same query  ', 'same query'],
  ])('rejects equivalent queries %j and %j before dispatch', async (first, second) => {
    const { app, db, requested } = harness()
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: [first, second], provider: 'openai' } })
    expect(response.statusCode).toBe(400)
    expect(requested).toHaveLength(0)
    expect(db.select().from(researchRuns).all()).toHaveLength(0)
  })

  it('rejects an unavailable executor before creating research rows', async () => {
    const { db } = harness()
    const app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      providerSummary: [{ name: 'openai', configured: true }],
      providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-4.1', knownModels: [{ id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' }], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model' }],
    } satisfies ApiRoutesOptions)
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['test'], provider: 'openai' } })
    expect(response.statusCode).toBe(422)
    expect(db.select().from(researchRuns).all()).toHaveLength(0)
  })

  it('freezes market scope and template provenance while sending the editor question verbatim', async () => {
    const { app, db, requested } = harness()
    const publishedPlan = publishResearchScopePlan(db)
    const templateVersion = '2026-09-09T11:00:00.000Z'
    db.insert(measurementQueryTemplates).values([
      { id: 'research-market-v1', projectId: 'alpha', name: 'Configured market', pattern: 'Services in {market}', variables: ['market'], createdAt: templateVersion, updatedAt: templateVersion },
      { id: 'research-property-v1', projectId: 'alpha', name: 'Configured property', pattern: 'Services at {property}', variables: ['property'], createdAt: templateVersion, updatedAt: templateVersion },
    ]).run()
    const payload = {
      queries: ['Does this market have pet-friendly apartments?'], provider: 'openai', idempotencyKey: 'market-template',
      scope: { kind: 'market', key: 'north-market', expectedPlanRevision: 1 },
      template: { templateId: 'research-market-v1', templateVersion },
    }
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })
    expect(created.statusCode).toBe(202)
    expect(created.json()).toMatchObject({
      location: null,
      scope: { kind: 'market', key: 'north-market', label: 'North market', planRevision: 1 },
      template: {
        templateId: 'research-market-v1', templateVersion,
        template: 'Services in {market}', bindings: { market: 'North market' },
        output: 'Services in North market',
      },
      queries: [{ query: payload.queries[0], queryClass: 'non-brand' }],
    })
    expect(requested).toHaveLength(1)

    const property = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: {
      queries: ['A final question with no property name'], provider: 'openai',
      scope: { kind: 'property', key: 'harbor', expectedPlanRevision: 1 },
      template: { templateId: 'research-property-v1', templateVersion },
    } })
    expect(property.statusCode).toBe(202)
    expect(property.json()).toMatchObject({
      scope: { kind: 'property', label: 'Harbor Homes' },
      template: { bindings: { property: 'Harbor Homes' }, output: 'Services at Harbor Homes' },
      queries: [{ query: 'A final question with no property name', queryClass: 'non-brand' }],
    })

    const nameInFinalText = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: {
      queries: ['Is Harbor Homes a good place to live?'], provider: 'openai',
    } })
    expect(nameInFinalText.statusCode).toBe(202)
    expect(nameInFinalText.json()).toMatchObject({ queries: [{ queryClass: 'branded' }] })

    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: {
      queries: ['group'], provider: 'openai', scope: { kind: 'group', key: 'regional' },
    } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: {
      queries: ['unknown'], provider: 'openai', scope: { kind: 'property', key: 'not-published' },
    } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: {
      queries: ['stale'], provider: 'openai', scope: { kind: 'market', key: 'north-market', expectedPlanRevision: 2 },
    } })).statusCode).toBe(400)

    const versionId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(measurementPlanVersions).values({
      id: versionId, projectId: 'alpha', revision: 2, canonicalJson: canonicalMeasurementPlanV2Json(publishedPlan),
      checksum: '2'.repeat(64), schemaVersion: 2, compiledChecksum: publishedPlan.compiledChecksum, createdAt: now,
    }).run()
    db.update(measurementPlans).set({ activeVersionId: versionId, updatedAt: now }).where(eq(measurementPlans.projectId, 'alpha')).run()
    const replay = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ id: created.json().id, scope: { planRevision: 1 }, template: { output: 'Services in North market' } })
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { ...payload, queries: ['different final question'] } })).statusCode).toBe(409)
  })

  it('freezes saved-template provenance and supports ordinary freeform research with no plan', async () => {
    const { app, db } = harness()
    const now = '2026-09-09T12:00:00.000Z'
    publishResearchScopePlan(db)
    db.insert(measurementQueryTemplates).values({
      id: 'saved-market', projectId: 'alpha', name: 'Saved market', pattern: 'Services in {submarket}, {market}',
      variables: ['submarket'], createdAt: now, updatedAt: now,
    }).run()
    const payload = {
      queries: ['The user edited this final question'], provider: 'openai', idempotencyKey: 'saved-template-retry',
      scope: { kind: 'market', key: 'north-market', expectedPlanRevision: 1 },
      template: { templateId: 'saved-market', templateVersion: now },
    }
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })
    expect(created.statusCode).toBe(202)
    expect(created.json()).toMatchObject({
      template: { templateId: 'saved-market', templateVersion: now, bindings: { submarket: 'North market' }, output: 'Services in North market, {market}' },
      queries: [{ query: payload.queries[0] }],
    })
    db.update(measurementQueryTemplates).set({ pattern: 'Changed {submarket}', updatedAt: '2026-09-09T13:00:00.000Z' }).where(eq(measurementQueryTemplates.id, 'saved-market')).run()
    const replay = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ id: created.json().id, template: { output: 'Services in North market, {market}' } })

    const freeform = await app.inject({ method: 'POST', url: '/api/v1/projects/beta/research/runs', payload: {
      queries: ['  exact editor question  '], provider: 'openai',
    } })
    expect(freeform.statusCode).toBe(202)
    expect(freeform.json()).toMatchObject({ scope: null, template: null, queries: [{ query: '  exact editor question  ', queryClass: 'non-brand' }] })

    const v1Plan = compileMeasurementPlan({
      schemaVersion: 1,
      targets: [{ stableKey: 'legacy-home', label: 'Legacy Homes', aliases: ['Legacy Homes'], urls: [{ kind: 'prefix', host: 'beta.com', pathPrefix: '/legacy', pathCase: 'insensitive' }] }],
      targetQuerySelections: [],
    }, {
      canonicalDomain: 'beta.com', ownedDomains: [], brandNames: ['beta'], defaultContext: null,
      locations: [], trackedQueries: [], expectedSnapshots: 1,
    })
    const v1VersionId = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id: v1VersionId, projectId: 'beta', revision: 1, canonicalJson: canonicalMeasurementPlanJson(v1Plan),
      checksum: '3'.repeat(64), schemaVersion: 1, compiledChecksum: v1Plan.compiledChecksum, createdAt: now,
    }).run()
    db.insert(measurementPlans).values({ projectId: 'beta', activeVersionId: v1VersionId, createdAt: now, updatedAt: now }).run()
    const v1Freeform = await app.inject({ method: 'POST', url: '/api/v1/projects/beta/research/runs', payload: {
      queries: ['Is Legacy Homes worth considering?'], provider: 'openai',
    } })
    expect(v1Freeform.statusCode).toBe(202)
    expect(v1Freeform.json()).toMatchObject({ scope: null, template: null, queries: [{ queryClass: 'branded' }] })
  })

  it('keeps idempotency retries from before scoped research compatible', async () => {
    const { app, db } = harness()
    const now = new Date().toISOString()
    const payload = { queries: ['legacy query'], provider: 'openai', idempotencyKey: 'legacy-retry' }
    const normalized = {
      queries: payload.queries, provider: payload.provider, model: null,
      location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' },
    }
    db.insert(researchRuns).values({
      id: 'legacy-run', projectId: 'alpha', status: 'completed', provider: 'openai', resolvedModel: 'gpt-4.1',
      totalQueries: 1, idempotencyKey: payload.idempotencyKey,
      requestHash: crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex'), createdAt: now,
    }).run()
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 'legacy-run', scope: null })
    expect(db.select().from(researchRuns).all()).toHaveLength(1)
  })
})


describe('research model defaults', () => {
  it('uses the same instance model as visibility, then project and explicit overrides', async () => {
    const { app, db } = harness({ getEffectiveProviderModels: () => ({ openai: 'gpt-instance' }) })
    const readDefault = async () => (await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })).json().providers[0].defaultModel
    const create = (model?: string) => app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['test'], provider: 'openai', ...(model ? { model } : {}) } })
    expect(await readDefault()).toBe('gpt-instance')
    expect((await create()).json()).toMatchObject({ requestedModel: null, resolvedModel: 'gpt-instance' })
    db.update(projects).set({ providerModels: { openai: 'gpt-project' } }).where(eq(projects.id, 'alpha')).run()
    expect(await readDefault()).toBe('gpt-project')
    expect((await create()).json()).toMatchObject({ requestedModel: null, resolvedModel: 'gpt-project' })
    expect((await create('gpt-override')).json()).toMatchObject({ requestedModel: 'gpt-override', resolvedModel: 'gpt-override' })
  })

  it('publishes cached models to research without invoking live discovery or changing defaults', async () => {
    const models = [{ id: 'gpt-new', displayName: 'New GPT', tier: 'standard' as const }]
    const getProviderModels = vi.fn(async () => models)
    const { app } = harness({ getProviderModels, getCachedProviderModels: () => models, getEffectiveProviderModels: () => ({ openai: 'gpt-instance' }) })
    const research = (await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })).json()
    expect(research.providers[0]).toMatchObject({ defaultModel: 'gpt-instance', knownModels: [{ id: 'gpt-instance' }, { id: 'gpt-new' }] })
    expect(getProviderModels).not.toHaveBeenCalled()
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json()
    expect(settings.providerCatalog[0].knownModels).toEqual(models)
    expect(getProviderModels).toHaveBeenCalledTimes(1)
  })

  it('uses bundled choices when a host provides only live discovery', async () => {
    const getProviderModels = vi.fn(async () => { throw new Error('Live discovery is forbidden') })
    const { app } = harness({ getProviderModels })
    const research = await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })
    expect(research.statusCode).toBe(200)
    expect(research.json().providers[0].knownModels).toMatchObject([{ id: 'gpt-4.1' }])
    expect(getProviderModels).not.toHaveBeenCalled()
  })
})


describe('model catalog fallback', () => {
  it('retains bundled choices for an unconfigured provider without attempting discovery', async () => {
    const lookedUp: string[] = []
    const { app } = harness({
      providerSummary: [{ name: 'openai', configured: false }],
      getProviderModels: async name => { lookedUp.push(name); return [] },
    })
    const response = await app.inject({ method: 'GET', url: '/api/v1/settings' })
    expect(response.statusCode).toBe(200)
    expect(response.json().providerCatalog[0].knownModels).toMatchObject([{ id: 'gpt-4.1' }])
    expect(lookedUp).toEqual([])
    await app.close()
  })

  it('retains bundled choices for an empty discovered catalog', async () => {
    const { app } = harness({ getProviderModels: async () => [], getEffectiveProviderModels: () => ({ openai: 'gpt-instance' }) })
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings' })).json()
    const research = (await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs' })).json()
    expect(settings.providerCatalog[0].knownModels).toMatchObject([{ id: 'gpt-4.1' }])
    expect(research.providers[0].knownModels).toMatchObject([{ id: 'gpt-instance' }, { id: 'gpt-4.1' }])
    await app.close()
  })
})
