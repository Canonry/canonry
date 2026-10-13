import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerRequestContext } from '@ainyc/canonry-api-routes/request-context'
import { competitors, createClient, migrate, projects, researchRunQueries, researchRuns, usageCounters } from '@ainyc/canonry-db'
import { executeResearchRun } from '../src/research-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'
import { reserveDailyQueryQuota } from '../src/usage-quota.js'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', () => ({ trackEvent }))
beforeEach(() => trackEvent.mockReset())

const cleanup: string[] = []
afterEach(() => cleanup.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

function setup(opts: {
  answer?: string
  citedDomains?: string[]
  competitorDomains?: string[]
  /** Curated aliases per competitor domain. */
  competitorAliases?: Record<string, string[]>
  failQueries?: boolean
  blockBad?: Promise<void>
  /** The registered provider name; `test` is not one telemetry knows. */
  provider?: string
  /** The text a failing provider call throws, as adapters word it. */
  failWith?: string
} = {}) {
  const provider = opts.provider ?? 'test'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-runner-'))
  cleanup.push(dir)
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'p', name: 'p', displayName: 'Alpha', canonicalDomain: 'alpha.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  for (const domain of opts.competitorDomains ?? []) {
    db.insert(competitors).values({ id: crypto.randomUUID(), projectId: 'p', domain, aliases: opts.competitorAliases?.[domain] ?? [], createdAt: now }).run()
  }
  db.insert(researchRuns).values({ id: 'r', projectId: 'p', status: 'queued', provider, resolvedModel: 'exact-model', totalQueries: 2, completedQueries: 0, failedQueries: 0, createdAt: now }).run()
  for (const [position, queryText] of ['good', 'bad'].entries()) {
    db.insert(researchRunQueries).values({
      id: crypto.randomUUID(), researchRunId: 'r', position, queryText,
      status: 'queued', resolvedModel: 'exact-model', groundingSources: [],
      citedDomains: [], searchQueries: [], createdAt: now,
    }).run()
  }
  const registry = new ProviderRegistry()
  const models: string[] = []
  registry.register({
    name: provider,
    executeTrackedQuery: async (_input: { query: string }, config: { model?: string }) => {
      models.push(config.model ?? '')
      if (_input.query === 'bad') await opts.blockBad
      if (opts.failQueries === true || (opts.failQueries === undefined && _input.query === 'bad')) {
        throw new Error(opts.failWith ?? 'provider failed')
      }
      return { rawResponse: {}, servedModel: undefined }
    },
    normalizeResult: () => ({
      provider: 'test', answerText: opts.answer ?? 'Alpha is cited',
      citedDomains: opts.citedDomains ?? ['alpha.com'], groundingSources: [], searchQueries: [],
    }),
    healthcheck: async () => ({ ok: true, provider: 'test', message: 'ok' }),
  } as never, {
    provider, model: 'wrong',
    quotaPolicy: { maxConcurrency: 2, maxRequestsPerMinute: 100, maxRequestsPerDay: 10 },
  })
  return { db, registry, models }
}
describe('executeResearchRun', () => {
  it('records partial results, preserves a null served model, and charges dispatched calls only', async () => {
    const { db, registry, models } = setup()
    await executeResearchRun(db, registry, 'r', 'p')
    const run = db.select().from(researchRuns).get()!
    const children = db.select().from(researchRunQueries).all()
    const completed = children.find(row => row.status === 'completed')!
    expect(run.status).toBe('partial')
    expect(models).toEqual(['exact-model', 'exact-model'])
    expect(completed.servedModel).toBeNull()
    expect(completed.answerMentioned).toBe(true)
    expect(completed.citationState).toBe('cited')
    expect(db.select().from(usageCounters).get()?.count).toBe(2)
  })
  it('fails before dispatch when daily quota would be exceeded', async () => {
    const { db, registry } = setup()
    const now = new Date().toISOString()
    db.insert(usageCounters).values({ id: 'u', scope: 'p:test', period: now.slice(0, 10), metric: 'queries', count: 9, updatedAt: now }).run()
    await executeResearchRun(db, registry, 'r', 'p')
    expect(db.select().from(researchRuns).get()?.status).toBe('failed')
    expect(db.select().from(usageCounters).get()?.count).toBe(9)
  })

  it('keeps mention and citation independent and completes an all-success batch', async () => {
    const { db, registry } = setup({ answer: 'Alpha is a strong choice.', citedDomains: ['third-party.example'], failQueries: false })
    await executeResearchRun(db, registry, 'r', 'p')
    const run = db.select().from(researchRuns).get()!
    const completed = db.select().from(researchRunQueries).all()
    expect(run.status).toBe('completed')
    expect(completed.every(row => row.status === 'completed')).toBe(true)
    expect(completed.every(row => row.answerMentioned === true && row.citationState === 'not-cited')).toBe(true)
  })

  it('does not treat a short canonical-domain label as an approved answer mention', async () => {
    const { db, registry } = setup({
      answer: 'AI can help teams compare options.',
      citedDomains: ['third-party.example'],
      failQueries: false,
    })
    db.update(projects).set({ displayName: 'Zebra', canonicalDomain: 'ai.com' }).run()

    await executeResearchRun(db, registry, 'r', 'p')

    const completed = db.select().from(researchRunQueries).all()
    expect(completed.every(row => row.answerMentioned === false)).toBe(true)
  })

  it('persists answer-text competitor names separately from cited competitor domains', async () => {
    const { db, registry } = setup({
      answer: '- **Rival**: a strong alternative for growing teams.',
      citedDomains: ['rival.example'],
      competitorDomains: ['rival.example'],
      failQueries: false,
    })
    await executeResearchRun(db, registry, 'r', 'p')
    const completed = db.select().from(researchRunQueries).all()
    expect(completed.every(row => row.namedCompetitors.includes('Rival'))).toBe(true)
    expect(completed.map(row => row.citedCompetitorDomains)).toEqual([['rival.example'], ['rival.example']])
  })

  it('names a competitor by its curated alias when the answer uses that name', async () => {
    const answer = '- **TuneSpoke**: a strong alternative for growing teams.'
    const run = async (aliases: string[]) => {
      const { db, registry } = setup({
        answer,
        citedDomains: ['independent.example'],
        competitorDomains: ['spoketuneworks.example'],
        competitorAliases: { 'spoketuneworks.example': aliases },
        failQueries: false,
      })
      await executeResearchRun(db, registry, 'r', 'p')
      return db.select().from(researchRunQueries).all()
    }
    // Without the alias the bullet's name lines up with no known competitor.
    expect((await run([])).map(row => row.namedCompetitors)).toEqual([[], []])
    const withAlias = await run(['TuneSpoke'])
    expect(withAlias.map(row => row.namedCompetitors)).toEqual([['TuneSpoke'], ['TuneSpoke']])
    // A name is not a citation.
    expect(withAlias.every(row => row.citedCompetitorDomains.length === 0)).toBe(true)
  })

  it('does not turn an answer-text competitor name into a citation', async () => {
    const { db, registry } = setup({
      answer: '- **Rival**: a strong alternative for growing teams.',
      citedDomains: ['independent.example'],
      competitorDomains: ['rival.example'],
      failQueries: false,
    })
    await executeResearchRun(db, registry, 'r', 'p')
    const completed = db.select().from(researchRunQueries).all()
    expect(completed.every(row => row.namedCompetitors.includes('Rival'))).toBe(true)
    expect(completed.every(row => row.citedCompetitorDomains.length === 0)).toBe(true)
  })

  it('does not turn a competitor citation into an answer-text name', async () => {
    const { db, registry } = setup({
      answer: 'An independent answer with no ranked competitors.',
      citedDomains: ['rival.example'],
      competitorDomains: ['rival.example'],
      failQueries: false,
    })
    await executeResearchRun(db, registry, 'r', 'p')
    const completed = db.select().from(researchRunQueries).all()
    expect(completed.every(row => row.namedCompetitors.length === 0)).toBe(true)
    expect(completed.map(row => row.citedCompetitorDomains)).toEqual([['rival.example'], ['rival.example']])
  })

  it('marks the parent failed when every provider call fails', async () => {
    const { db, registry } = setup({ failQueries: true })
    await executeResearchRun(db, registry, 'r', 'p')
    const run = db.select().from(researchRuns).get()!
    expect(run.status).toBe('failed')
    expect(run.completedQueries).toBe(0)
    expect(run.failedQueries).toBe(2)
  })

  it('updates parent progress as each query reaches a terminal state', async () => {
    let releaseBad!: () => void
    const blockBad = new Promise<void>(resolve => { releaseBad = resolve })
    const { db, registry } = setup({ failQueries: false, blockBad })
    const execution = executeResearchRun(db, registry, 'r', 'p')
    await new Promise(resolve => setTimeout(resolve, 0))
    const inFlight = db.select().from(researchRuns).get()!
    expect(inFlight.status).toBe('running')
    expect(inFlight.completedQueries).toBe(1)
    expect(inFlight.failedQueries).toBe(0)
    releaseBad()
    await execution
  })

  it('claims a queued batch once when duplicate executor callbacks race', async () => {
    const { db, registry, models } = setup({ failQueries: false })
    await Promise.all([
      executeResearchRun(db, registry, 'r', 'p'),
      executeResearchRun(db, registry, 'r', 'p'),
    ])
    expect(models).toEqual(['exact-model', 'exact-model'])
    expect(db.select().from(researchRuns).get()?.status).toBe('completed')
  })

  it('finalizes claimed batches when setup fails after the claim', async () => {
    const { db } = setup({ failQueries: false })
    const registry = new ProviderRegistry()
    await executeResearchRun(db, registry, 'r', 'p')
    const run = db.select().from(researchRuns).get()!
    expect(run.status).toBe('failed')
    expect(run.failedQueries).toBe(2)
    expect(db.select().from(researchRunQueries).all().every(row => row.status === 'failed')).toBe(true)
  })

  it('does not leave a claimed batch running when a child status write fails', async () => {
    const { db, registry } = setup({ failQueries: false })
    let threw = false
    const failingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'update') return Reflect.get(target, property, receiver)
        return (table: unknown) => {
          if (table === researchRunQueries && !threw) {
            threw = true
            throw new Error('injected child status write failure')
          }
          return target.update(table as typeof researchRunQueries)
        }
      },
    })
    await executeResearchRun(failingDb as typeof db, registry, 'r', 'p')
    const run = db.select().from(researchRuns).get()!
    expect(threw).toBe(true)
    expect(run.status).toBe('partial')
    expect(db.select().from(researchRunQueries).all().every(row => row.status === 'completed' || row.status === 'failed')).toBe(true)
  })

  it('uses the same atomic daily reservation bucket as monitoring runs', () => {
    const { db } = setup()
    const period = new Date().toISOString().slice(0, 10)
    expect(reserveDailyQueryQuota(db, { scope: 'p:test', period, count: 8, limit: 10 }).reserved).toBe(true)
    const second = reserveDailyQueryQuota(db, { scope: 'p:test', period, count: 3, limit: 10 })
    expect(second).toEqual({ reserved: false, used: 8 })
    expect(db.select().from(usageCounters).get()?.count).toBe(8)
  })
})

describe('research run outcome telemetry', () => {
  const researched = { feature: 'research', operation: 'run', durationBucket: expect.any(String) }

  it('reports a finished batch with its queries, saved answers and failures, and the provider when telemetry knows it', async () => {
    const complete = setup({ failQueries: false, provider: 'gemini' })
    await executeResearchRun(complete.db, complete.registry, 'r', 'p')
    // One query fails on the provider's account; the adapter's text is classified, never sent.
    const partial = setup({ failWith: '[provider-test] 401 Incorrect API key provided: sk-live-123' })
    await executeResearchRun(partial.db, partial.registry, 'r', 'p')

    expect(trackEvent.mock.calls).toEqual([
      ['feature.completed', { ...researched, trigger: 'manual', provider: 'gemini', status: 'succeeded', counts: { queries: 2, snapshots: 2, failures: 0 } }, undefined],
      ['feature.completed', {
        ...researched, trigger: 'manual', status: 'partial', reasonCode: 'INVALID_CREDENTIALS', errorName: 'Error',
        counts: { queries: 2, snapshots: 1, failures: 1 },
      }, { errorCode: 'INVALID_CREDENTIALS' }],
    ])
    expect(JSON.stringify(trackEvent.mock.calls)).not.toContain('sk-live')
  })

  it('reports a batch refused before dispatch, and one recovered at startup, as failed with the reason', async () => {
    const quota = setup()
    const now = new Date().toISOString()
    quota.db.insert(usageCounters).values({ id: 'u', scope: 'p:test', period: now.slice(0, 10), metric: 'queries', count: 9, updatedAt: now }).run()
    await executeResearchRun(quota.db, quota.registry, 'r', 'p')
    const unregistered = setup()
    await executeResearchRun(unregistered.db, new ProviderRegistry(), 'r', 'p', { trigger: 'startup' })

    expect(trackEvent.mock.calls).toEqual([
      ['feature.completed', { ...researched, trigger: 'manual', status: 'failed', reasonCode: 'QUOTA_EXCEEDED', counts: { queries: 2, snapshots: 0, failures: 2 } }, { errorCode: 'QUOTA_EXCEEDED' }],
      ['feature.completed', {
        ...researched, trigger: 'startup', surface: 'system', status: 'failed', reasonCode: 'NOT_CONNECTED',
        counts: { queries: 2, snapshots: 0, failures: 2 },
      }, { errorCode: 'NOT_CONNECTED' }],
    ])
  })

  it('reports a batch an agent requested as that agent, after the request has ended', async () => {
    const { db, registry } = setup({ failQueries: false, provider: 'gemini' })
    const app = Fastify()
    registerRequestContext(app)
    let execution: Promise<void> | undefined
    // Dispatched from the request, as the route's callback does, and finished after it.
    app.post('/research', async () => {
      execution = executeResearchRun(db, registry, 'r', 'p')
      return { queued: true }
    })
    await app.inject({ method: 'POST', url: '/research', headers: { 'user-agent': 'canonry-mcp', 'x-canonry-surface': 'mcp-stdio', 'x-canonry-agent': 'claude' } })
    await app.close()
    await execution

    expect(trackEvent.mock.calls).toEqual([
      ['feature.completed', {
        ...researched, trigger: 'agent', surface: 'mcp-stdio', agent: 'claude', provider: 'gemini', status: 'succeeded',
        counts: { queries: 2, snapshots: 2, failures: 0 },
      }, undefined],
    ])
  })

  it('reports nothing for a batch another worker already claimed', async () => {
    const { db, registry } = setup({ failQueries: false })
    await Promise.all([executeResearchRun(db, registry, 'r', 'p'), executeResearchRun(db, registry, 'r', 'p')])
    expect(trackEvent).toHaveBeenCalledTimes(1)
  })
})
