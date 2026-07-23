import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, researchRunQueries, researchRuns, usageCounters } from '@ainyc/canonry-db'
import { executeResearchRun } from '../src/research-runner.js'
import { ProviderRegistry } from '../src/provider-registry.js'

const cleanup: string[] = []
afterEach(() => cleanup.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

function setup(opts: {
  answer?: string
  citedDomains?: string[]
  failQueries?: boolean
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-runner-'))
  cleanup.push(dir)
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'p', name: 'p', displayName: 'Alpha', canonicalDomain: 'alpha.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  db.insert(researchRuns).values({ id: 'r', projectId: 'p', status: 'queued', provider: 'test', resolvedModel: 'exact-model', totalQueries: 2, completedQueries: 0, failedQueries: 0, createdAt: now }).run()
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
    name: 'test',
    executeTrackedQuery: async (_input: { query: string }, config: { model?: string }) => {
      models.push(config.model ?? '')
      if (opts.failQueries === true || (opts.failQueries === undefined && _input.query === 'bad')) {
        throw new Error('provider failed')
      }
      return { rawResponse: {}, servedModel: undefined }
    },
    normalizeResult: () => ({
      provider: 'test', answerText: opts.answer ?? 'Alpha is cited',
      citedDomains: opts.citedDomains ?? ['alpha.com'], groundingSources: [], searchQueries: [],
    }),
    healthcheck: async () => ({ ok: true, provider: 'test', message: 'ok' }),
  } as never, {
    provider: 'test', model: 'wrong',
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

  it('marks the parent failed when every provider call fails', async () => {
    const { db, registry } = setup({ failQueries: true })
    await executeResearchRun(db, registry, 'r', 'p')
    const run = db.select().from(researchRuns).get()!
    expect(run.status).toBe('failed')
    expect(run.completedQueries).toBe(0)
    expect(run.failedQueries).toBe(2)
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
})
