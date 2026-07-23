import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, queries, researchRuns, runs } from '@ainyc/canonry-db'
import { ResearchRunStatuses } from '@ainyc/canonry-contracts'
import { apiRoutes, type ApiRoutesOptions } from '../src/index.js'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-'))
  const db = createClient(path.join(dir, 'test.db')); migrate(db)
  const now = new Date().toISOString()
  for (const name of ['alpha', 'beta']) db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.com`, country: 'US', language: 'en', providers: ['openai'], locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }], defaultLocation: 'New York', createdAt: now, updatedAt: now }).run()
  const app = Fastify(); const requested: string[] = []
  app.register(apiRoutes, { db, skipAuth: true, onResearchRunRequested: id => requested.push(id), providerSummary: [{ name: 'openai', configured: true }], providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-4.1', knownModels: ['gpt-4.1'], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model' }] } satisfies ApiRoutesOptions)
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { app, db, requested }
}

describe('research routes', () => {
  it('persists an isolated batch, lists/details it, and protects retry/project boundaries', async () => {
    const { app, db, requested } = harness()
    const payload = { queries: ['best solar installer', 'solar cost'], provider: 'openai', model: 'gpt-4.1', location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' }, idempotencyKey: 'retry-1' }
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload })
    expect(created.statusCode).toBe(202); const body = created.json(); expect(body.queries).toHaveLength(2); expect(requested).toHaveLength(1)
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

  it('rejects an unavailable executor before creating research rows', async () => {
    const { db } = harness()
    const app = Fastify()
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      providerSummary: [{ name: 'openai', configured: true }],
      providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-4.1', knownModels: ['gpt-4.1'], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model' }],
    } satisfies ApiRoutesOptions)
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/research/runs', payload: { queries: ['test'], provider: 'openai' } })
    expect(response.statusCode).toBe(422)
    expect(db.select().from(researchRuns).all()).toHaveLength(0)
  })
})
