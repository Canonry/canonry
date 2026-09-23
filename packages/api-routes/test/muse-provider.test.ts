import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMeasurementRunManifestV1 } from '@ainyc/canonry-contracts'
import { apiKeys, createClient, migrate, projects, queries, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const ROOT_KEY = 'cnry_muse_root'
const READ_KEY = 'cnry_muse_read'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let dispatched: Array<{ id: string; providers: string[] | undefined }>
let providerUpdates: Array<{ name: string; key: string; model: string | undefined }>

function request(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token = ROOT_KEY) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  })
}

async function seedProject(name: string) {
  const created = await request('PUT', `/api/v1/projects/${name}`, {
    displayName: name,
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: ['muse'],
    providerModels: { muse: 'muse-spark-1.3' },
  })
  expect(created.statusCode, created.body).toBe(201)
  const added = await request('POST', `/api/v1/projects/${name}/queries`, { queries: ['best widget shops'] })
  expect(added.statusCode, added.body).toBe(200)
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-muse-route-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  for (const [token, scopes] of [[ROOT_KEY, ['*']], [READ_KEY, ['read']]] as const) {
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: token,
      keyHash: hashApiKey(token),
      keyPrefix: token.slice(0, 9),
      scopes: [...scopes],
      createdAt: new Date().toISOString(),
    }).run()
  }
  app = Fastify()
  dispatched = []
  providerUpdates = []
  app.register(apiRoutes, {
    db,
    onRunCreated: (id, _projectId, providers) => dispatched.push({ id, providers }),
    getRunnableProviderNames: () => ['muse', 'gemini'],
    getEffectiveProviderModels: () => ({ muse: 'muse-spark-1.3', gemini: 'gemini-2.5-flash' }),
    providerSummary: [{ name: 'muse', configured: true }],
    providerAdapters: [{
      name: 'muse', displayName: 'Muse Spark', mode: 'api', modelConfigurable: true,
      defaultModel: 'muse-spark-1.3', knownModels: ['muse-spark-1.3'],
      modelValidationPattern: /^muse-spark-/, modelValidationHint: 'Muse Spark model ID',
    }],
    onProviderUpdate: (name, key, model) => {
      providerUpdates.push({ name, key, model })
      return { name, configured: true }
    },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('Muse through authenticated project and run routes', () => {
  it('selects Muse for a Simple project and queues only Muse for an explicit run', async () => {
    await seedProject('simple')
    const project = await request('GET', '/api/v1/projects/simple', undefined, READ_KEY)
    expect(project.statusCode).toBe(200)
    expect(project.json()).toMatchObject({ providers: ['muse'], providerModels: { muse: 'muse-spark-1.3' } })

    const denied = await request('POST', '/api/v1/projects/simple/runs', { providers: ['muse'] }, READ_KEY)
    expect(denied.statusCode).toBe(403)
    expect(db.select().from(runs).all()).toHaveLength(0)

    const triggered = await request('POST', '/api/v1/projects/simple/runs', { providers: ['muse'] })
    expect(triggered.statusCode, triggered.body).toBe(201)
    const row = db.select().from(runs).where(eq(runs.id, triggered.json().id as string)).get()!
    expect(row.measurementPlanVersionId).toBeNull()
    expect(dispatched).toEqual([{ id: row.id, providers: ['muse'] }])
  })

  it('accepts Muse settings through the typed route and keeps read-only keys out', async () => {
    const denied = await request('PUT', '/api/v1/settings/providers/muse', { model: 'muse-spark-1.3' }, READ_KEY)
    expect(denied.statusCode).toBe(403)
    expect(providerUpdates).toEqual([])

    const updated = await request('PUT', '/api/v1/settings/providers/muse', {
      apiKey: 'test-muse-key', model: 'muse-spark-1.3',
    })
    expect(updated.statusCode, updated.body).toBe(200)
    expect(providerUpdates).toEqual([{ name: 'muse', key: 'test-muse-key', model: 'muse-spark-1.3' }])
  })

  it('freezes Muse slots in an Advanced plan and rejects a different provider count', async () => {
    await seedProject('advanced')
    const queryId = db.select({ id: queries.id }).from(queries).get()!.id
    const published = await request('PUT', '/api/v1/projects/advanced/measurement-plan', {
      expectedActiveRevision: null,
      plan: {
        schemaVersion: 1,
        targets: [{ stableKey: 'widget', label: 'Widget', aliases: ['Widget'], urls: [{
          kind: 'prefix', host: 'example.com', pathPrefix: '/widgets', pathCase: 'insensitive',
        }] }],
        groups: [{ stableKey: 'all', label: 'All', targetKeys: ['widget'] }],
        targetQuerySelections: [{ targetKey: 'widget', queryIds: [queryId] }],
      },
    })
    expect(published.statusCode, published.body).toBe(201)

    const triggered = await request('POST', '/api/v1/projects/advanced/runs', { providers: ['muse'] })
    expect(triggered.statusCode, triggered.body).toBe(201)
    const run = db.select().from(runs).where(eq(runs.id, triggered.json().id as string)).get()!
    expect(run.measurementPlanVersionId).toBeTruthy()
    const manifest = parseMeasurementRunManifestV1(run.measurementManifest)
    expect(manifest.expectedSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'muse', queryText: 'best widget shops' }),
    ]))
    expect(new Set(manifest.expectedSlots.map(slot => slot.provider))).toEqual(new Set(['muse']))

    db.update(runs).set({ status: 'completed' }).where(eq(runs.id, run.id)).run()
    const changed = await request('POST', '/api/v1/projects/advanced/runs', { providers: ['muse', 'gemini'] })
    expect(changed.statusCode).toBe(400)
    expect(db.select().from(runs).all()).toHaveLength(1)
    expect(db.select().from(projects).where(eq(projects.name, 'advanced')).get()?.providers).toEqual(['muse'])
  })
})
