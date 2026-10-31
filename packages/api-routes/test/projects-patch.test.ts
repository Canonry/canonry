import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditLog, createClient, measurementPlans, measurementPlanVersions, migrate, projects } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const initialProject = {
  displayName: 'Patch Project',
  canonicalDomain: 'patch.example',
  ownedDomains: ['www.patch.example'],
  aliases: ['Patch Project', 'Patch Brand'],
  qualifiedAliases: ['Patch Brand'],
  country: 'US',
  language: 'en',
  tags: ['stable'],
  labels: { team: 'platform' },
  providers: ['openai'],
  providerModels: { openai: 'gpt-test' },
  providerDispatchModes: {},
  locations: [{ label: 'HQ', city: 'Example City', region: 'EX', country: 'US' }],
  defaultLocation: 'HQ',
  autoExtractBacklinks: true,
  measurement: {
    marketingHosts: ['offers.patch.example'],
    brandTerms: ['Patch Project'],
    leadEventNames: ['generate_lead', 'book_demo'],
  },
}

let tmpDir: string
let db: ReturnType<typeof createClient>
let app: ReturnType<typeof Fastify>
let aliasCallbacks: string[]

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-project-patch-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  aliasCallbacks = []
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onAliasesChanged: (_id, name) => aliasCallbacks.push(name),
    providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-test', knownModels: [], modelValidationPattern: /^gpt-/, modelValidationHint: 'gpt model' }],
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function seed(name = 'patch-project') {
  const response = await app.inject({ method: 'PUT', url: `/api/v1/projects/${name}`, payload: initialProject })
  expect(response.statusCode).toBe(201)
  return response.json() as Record<string, unknown>
}

describe('PATCH project', () => {
  it('changes one measurement list while preserving Simple project state', async () => {
    const before = await seed()
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/patch-project',
      payload: { measurement: { leadEventNames: ['a_b'] } },
    })
    expect(response.statusCode).toBe(200)
    const updated = response.json()
    const { updatedAt: _beforeUpdatedAt, ...stableBefore } = before
    expect(updated).toMatchObject({
      ...stableBefore,
      measurement: {
        marketingHosts: ['offers.patch.example'],
        brandTerms: ['Patch Project'],
        leadEventNames: ['a_b'],
      },
      configRevision: (before.configRevision as number) + 1,
    })
    expect(updated.configSource).toBe(before.configSource)
    expect(db.select().from(projects).where(eq(projects.name, 'patch-project')).get()?.measurement).toEqual(updated.measurement)
    expect(aliasCallbacks).toEqual([])
  })

  it('preserves nested measurement and skips alias callbacks on an active Advanced portfolio', async () => {
    const before = await seed('advanced-patch-project')
    const plan = measurementPlanV2Fixture()
    const versionId = 'advanced-patch-version'
    const now = new Date().toISOString()
    db.insert(measurementPlanVersions).values({
      id: versionId,
      projectId: before.id as string,
      revision: 1,
      canonicalJson: JSON.stringify(plan),
      checksum: 'a'.repeat(64),
      schemaVersion: 2,
      createdAt: now,
    }).run()
    db.insert(measurementPlans).values({ projectId: before.id as string, activeVersionId: versionId, createdAt: now, updatedAt: now }).run()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/advanced-patch-project',
      payload: { measurement: { brandTerms: ['Advanced Patch'] } },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().measurement).toEqual({
      marketingHosts: ['offers.patch.example'],
      brandTerms: ['Advanced Patch'],
      leadEventNames: ['generate_lead', 'book_demo'],
    })
    expect(aliasCallbacks).toEqual([])
  })

  it('preserves keep-on-omit fields when aliases are patched', async () => {
    await seed()
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/patch-project',
      payload: { aliases: ['Other Brand'] },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ aliases: ['Other Brand'], qualifiedAliases: [] })
  })

  it('rejects an empty or unknown patch and never creates an unknown project', async () => {
    await seed()
    const empty = await app.inject({ method: 'PATCH', url: '/api/v1/projects/patch-project', payload: {} })
    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    const unknown = await app.inject({ method: 'PATCH', url: '/api/v1/projects/patch-project', payload: { typo: true } })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().error.details.issues[0].path).toBe('typo')
    const missing = await app.inject({ method: 'PATCH', url: '/api/v1/projects/missing-patch-project', payload: { measurement: { brandTerms: ['x'] } } })
    expect(missing.statusCode).toBe(404)
    expect(db.select().from(projects).where(eq(projects.name, 'missing-patch-project')).get()).toBeUndefined()
  })

  it('rejects revision-only and empty nested patches without auditing or incrementing the revision', async () => {
    const before = await seed()
    const auditBefore = db.select().from(auditLog).all()
    for (const payload of [{ expectedConfigRevision: before.configRevision }, { measurement: {} }]) {
      const response = await app.inject({ method: 'PATCH', url: '/api/v1/projects/patch-project', payload })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
      expect(db.select().from(projects).where(eq(projects.id, before.id as string)).get()?.configRevision).toBe(before.configRevision)
      expect(db.select().from(auditLog).all()).toEqual(auditBefore)
    }
  })

  it('rejects a stale revision without changing the row', async () => {
    const before = await seed()
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/patch-project',
      payload: { expectedConfigRevision: (before.configRevision as number) + 1, measurement: { brandTerms: ['stale'] } },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'PROJECT_REVISION_CONFLICT', details: { expected: (before.configRevision as number) + 1, actual: before.configRevision } } })
    expect(db.select().from(projects).where(eq(projects.name, 'patch-project')).get()?.measurement).toEqual(initialProject.measurement)
  })
})
