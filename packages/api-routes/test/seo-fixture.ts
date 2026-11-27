import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { apiKeys, createClient, migrate, projects, runs, seoJobs, seoTasks } from '@canonry/canonry-db'
import { RunKinds, RunStatuses, RunTriggers, SeoCapabilities, SeoProviders, SeoRunStatuses, type RunTrigger, type SeoAdapter, type SeoAdapterRequest, type SeoProfileInput, type SeoResults } from '@canonry/canonry-contracts'
import { apiRoutes, hashApiKey, type ApiRoutesOptions } from '../src/index.js'

export const seoProfileFixture: SeoProfileInput = {
  name: 'US organic search', connectionId: 'primary', capabilities: [SeoCapabilities['keyword-metrics']], targets: [], keywords: ['solar installer'],
  locationCode: 2840, languageCode: 'en', limit: 100, scope: { kind: 'project' },
}
export function seedSeoKey(db: ReturnType<typeof createClient>, id: string, scopes: string[], projectId?: string): string {
  const token = `cnry_seo_${id}`
  db.insert(apiKeys).values({ id, name: id, keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes, projectId, createdAt: new Date().toISOString() }).run()
  return token
}
export function createSeoHarness(options: Partial<ApiRoutesOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-seo-'))
  const db = createClient(path.join(dir, 'test.db')); migrate(db)
  const now = new Date().toISOString()
  for (const name of ['alpha', 'beta']) db.insert(projects).values({ id: name, name, displayName: name, canonicalDomain: `${name}.com`, country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  const state = { policy: { maxRunCostMicros: 1000, accountDailyLimitMicros: 1000, accountMonthlyLimitMicros: 1000, projectMonthlyLimitMicros: 1000 }, accountKey: 'account-a', catalogRevision: 'prices-1', costMicros: 100, executions: 0 }
  const adapter: SeoAdapter = {
    provider: SeoProviders.dataforseo,
    get accountKey() { return state.accountKey },
    capabilities: [SeoCapabilities['keyword-metrics'], SeoCapabilities['domain-intelligence'], SeoCapabilities['ranked-keywords'], SeoCapabilities['competitor-discovery'], SeoCapabilities['keyword-gaps']],
    estimate: () => ({ maxCostMicros: state.costMicros, catalogRevision: state.catalogRevision }),
    execute: async () => { state.executions++; throw new Error('Unexpected live request in a stored-read fixture') },
  }
  const requested: string[] = []
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, getSeoRuntime: () => ({ connections: [{ id: 'primary', label: 'SEO provider', adapter }], policy: state.policy }), onSeoRunRequested: id => { requested.push(id) }, ...options })
  return { app, db, state, adapter, requested, close: async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

/** Seed durable saved refreshes, including provider gaps and frozen scopes from earlier revisions. */
export function seedSeoEvidence(db: ReturnType<typeof createClient>, input: {
  id: string; projectId: string; profileId: string; profile: SeoProfileInput; profileRevision?: number
  createdAt: string; finishedAt: string; trigger?: RunTrigger
  status: 'completed' | 'partial' | 'failed' | 'reconciliation-required'; scopeSnapshot?: Record<string, unknown>
  tasks: Array<{ request: SeoAdapterRequest; status?: 'completed' | 'partial' | 'failed' | 'reconciliation-required'; results: SeoResults }>
}) {
  const { id, projectId, profileId, profile, status, createdAt, finishedAt } = input
  db.insert(runs).values({
    id, projectId, kind: RunKinds['seo-sync'], status: status === SeoRunStatuses['reconciliation-required'] ? RunStatuses.failed : status,
    trigger: input.trigger ?? RunTriggers.manual, createdAt, finishedAt,
  }).run()
  db.insert(seoJobs).values({
    id, runId: id, projectKey: projectId, projectId, profileId, profile, profileRevision: input.profileRevision ?? 1,
    scopeSnapshot: input.scopeSnapshot ?? { mode: 'simple', scope: profile.scope },
    requestHash: id, idempotencyKey: id, principalId: 'fixture', connectionId: profile.connectionId, accountKey: 'fixture-account-key',
    status, createdAt, finishedAt, buckets: [],
  }).run()
  if (input.tasks.length > 0) db.insert(seoTasks).values(input.tasks.map((task, index) => ({
    id: `${id}-task-${index}`, jobId: id, status: task.status ?? status, request: task.request, results: task.results,
    catalogRevision: 'fixture-catalog', reservedMicros: 200, actualMicros: 100, finishedAt,
  }))).run()
}
