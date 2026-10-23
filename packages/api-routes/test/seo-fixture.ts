import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { apiKeys, createClient, migrate, projects } from '@canonry/canonry-db'
import { SeoCapabilities, SeoProviders, type SeoAdapter, type SeoProfileInput } from '@canonry/canonry-contracts'
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
    capabilities: [SeoCapabilities['keyword-metrics'], SeoCapabilities['domain-intelligence'], SeoCapabilities['ranked-keywords']],
    estimate: () => ({ maxCostMicros: state.costMicros, catalogRevision: state.catalogRevision }),
    execute: async () => { state.executions++; throw new Error('Unexpected live request in a stored-read fixture') },
  }
  const requested: string[] = []
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, getSeoRuntime: () => ({ connections: [{ id: 'primary', label: 'SEO provider', adapter }], policy: state.policy }), onSeoRunRequested: id => { requested.push(id) }, ...options })
  return { app, db, state, adapter, requested, close: async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}
