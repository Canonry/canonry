import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-project-patch-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
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

  it('rejects a stale revision without changing the row', async () => {
    const before = await seed()
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/projects/patch-project',
      payload: { expectedConfigRevision: (before.configRevision as number) - 1, measurement: { brandTerms: ['stale'] } },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'PROJECT_REVISION_CONFLICT', details: { expected: 0, actual: before.configRevision } } })
    expect(db.select().from(projects).where(eq(projects.name, 'patch-project')).get()?.measurement).toEqual(initialProject.measurement)
  })
})
