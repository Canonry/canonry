import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, queries, runs, querySnapshots, researchRuns, researchRunQueries, auditLog } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })
function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'results-clear-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  for (const name of ['alpha', 'beta']) db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.example`, country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  db.insert(queries).values({ id: 'query', projectId: 'alpha', query: 'best example', createdAt: now }).run()
  for (const [id, projectId, kind] of [['visibility', 'alpha', 'answer-visibility'], ['probe', 'alpha', 'answer-visibility'], ['keep', 'alpha', 'answer-visibility'], ['audit', 'alpha', 'site-audit'], ['backlinks', 'alpha', 'backlink-extract'], ['other', 'beta', 'answer-visibility']]) {
    db.insert(runs).values({ id: id!, projectId: projectId!, kind: kind!, status: 'completed', trigger: id === 'probe' ? 'probe' : 'manual', createdAt: now }).run()
  }
  db.insert(querySnapshots).values({ id: 'answer', runId: 'visibility', queryId: 'query', provider: 'openai', citationState: 'cited', createdAt: now }).run()
  db.insert(researchRuns).values({ id: 'research', projectId: 'alpha', status: 'completed', provider: 'openai', resolvedModel: 'gpt-test', totalQueries: 1, createdAt: now }).run()
  db.insert(researchRunQueries).values({ id: 'research-answer', researchRunId: 'research', position: 0, queryText: 'test query', resolvedModel: 'gpt-test', status: 'completed', createdAt: now }).run()
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  cleanup.push(async () => { await app.close(); db.$client.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const clear = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/projects/alpha/results/clear', payload })
  return { db, clear }
}
const selection = { runIds: ['visibility', 'probe'], researchRunIds: ['research'] }

describe('saved-result cleanup', () => {
  it('previews by default without removing any saved evidence', async () => {
    const { db, clear } = harness()
    const response = await clear(selection)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ...selection, dryRun: true, querySnapshots: 1, researchQueries: 1 })
    expect(db.select().from(runs).all()).toHaveLength(6)
    expect(db.select().from(querySnapshots).all()).toHaveLength(1)
    expect(db.select().from(researchRuns).all()).toHaveLength(1)
    expect(db.select().from(auditLog).all()).toHaveLength(0)
  })
  it('clears only selected evidence and keeps query configuration and unrelated runs', async () => {
    const { db, clear } = harness()
    const before = db.select().from(projects).all()
    const response = await clear({ ...selection, confirm: true })
    expect(response.statusCode).toBe(200)
    expect(response.json().dryRun).toBe(false)
    expect(db.select().from(runs).all().map(run => run.id).sort()).toEqual(['audit', 'backlinks', 'keep', 'other'])
    expect(db.select().from(querySnapshots).all()).toEqual([])
    expect(db.select().from(researchRuns).all()).toEqual([])
    expect(db.select().from(researchRunQueries).all()).toEqual([])
    expect(db.select().from(queries).all()).toHaveLength(1)
    expect(db.select().from(projects).all()).toEqual(before)
    expect(db.select().from(auditLog).get()?.action).toBe('results.cleared')
  })
  it.each([['audit', 400], ['other', 404], ['missing', 404]] as const)('refuses %s atomically', async (id, status) => {
    const { db, clear } = harness()
    const response = await clear({ ...selection, runIds: ['visibility', id], confirm: true })
    expect(response.statusCode).toBe(status)
    expect(db.select().from(runs).all()).toHaveLength(6)
    expect(db.select().from(researchRunQueries).all()).toHaveLength(1)
  })
  it.each(['visibility', 'research'])('refuses active %s work even when it is not selected', async kind => {
    const { db, clear } = harness()
    if (kind === 'visibility') db.insert(runs).values({ id: 'active', projectId: 'alpha', kind: 'answer-visibility', status: 'running', createdAt: new Date().toISOString() }).run()
    else db.insert(researchRuns).values({ id: 'active', projectId: 'alpha', status: 'queued', provider: 'openai', resolvedModel: 'gpt-test', totalQueries: 1, createdAt: new Date().toISOString() }).run()
    expect((await clear({ ...selection, confirm: true })).statusCode).toBe(409)
    expect(db.select().from(querySnapshots).all()).toHaveLength(1)
  })
  it.each([{}, { runIds: ['visibility', 'visibility'] }, { runIds: ['visibility'], confirm: 'yes' }])('rejects ambiguous selections', async payload => {
    const { clear } = harness()
    expect((await clear(payload)).statusCode).toBe(400)
  })
})
