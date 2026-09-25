import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ProviderAdapterInfo } from '../src/settings.js'

// `providerDispatchModes` is the project's preference for SCHEDULED sweeps.
// It rides every project write surface the way `providerModels` does — create,
// upsert, apply, export — but an omitted value leaves the stored preference
// alone, so an edit that does not know about it (the dashboard's settings
// save, a config converge) never clears it.

const ADAPTERS: ProviderAdapterInfo[] = ['claude', 'openai', 'gemini'].map(name => ({
  name,
  displayName: name,
  mode: 'api',
  modelConfigurable: true,
  defaultModel: `${name}-default`,
  knownModels: [],
  modelValidationPattern: /./,
  modelValidationHint: '',
}))

const BODY = { displayName: 'Acme', canonicalDomain: 'acme.com', country: 'US', language: 'en', providers: ['claude', 'openai'] }

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

function stored(name = 'acme') {
  return db.select({ modes: projects.providerDispatchModes }).from(projects).where(eq(projects.name, name)).get()?.modes
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-project-dispatch-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, providerAdapters: ADAPTERS })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('project providerDispatchModes', () => {
  it('is stored and returned on create', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { ...BODY, name: 'acme', providerDispatchModes: { claude: 'batch' } } })
    expect(response.statusCode).toBe(201)
    expect(response.json().providerDispatchModes).toEqual({ claude: 'batch' })
    expect(stored()).toEqual({ claude: 'batch' })
  })

  it('defaults to {} and is always on the project DTO', async () => {
    await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', payload: BODY })
    expect(stored()).toEqual({})
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/acme' })).json().providerDispatchModes).toEqual({})
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects' })).json()[0].providerDispatchModes).toEqual({})
  })

  it('an upsert that omits it leaves the stored preference alone; an explicit map replaces it', async () => {
    await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', payload: { ...BODY, providerDispatchModes: { claude: 'batch' } } })

    const untouched = await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', payload: { ...BODY, displayName: 'Acme Inc' } })
    expect(untouched.json().providerDispatchModes).toEqual({ claude: 'batch' })

    const replaced = await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', payload: { ...BODY, providerDispatchModes: { openai: 'batch', claude: 'sync' } } })
    expect(replaced.json().providerDispatchModes).toEqual({ openai: 'batch', claude: 'sync' })

    const cleared = await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', payload: { ...BODY, providerDispatchModes: {} } })
    expect(cleared.json().providerDispatchModes).toEqual({})
    expect(stored()).toEqual({})
  })

  it('drops the preference for an engine the project no longer runs', async () => {
    await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', payload: { ...BODY, providerDispatchModes: { claude: 'batch', openai: 'batch' } } })
    const narrowed = await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', payload: { ...BODY, providers: ['openai'] } })
    expect(narrowed.json().providerDispatchModes).toEqual({ openai: 'batch' })
  })

  it('refuses an unknown provider and an unknown mode', async () => {
    const unknownProvider = await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', payload: { ...BODY, providerDispatchModes: { mistral: 'batch' } } })
    expect(unknownProvider.statusCode).toBe(400)
    expect(unknownProvider.json().error).toMatchObject({ code: 'VALIDATION_ERROR', details: { provider: 'mistral' } })

    const unknownMode = await app.inject({ method: 'PUT', url: '/api/v1/projects/acme', payload: { ...BODY, providerDispatchModes: { claude: 'flex' } } })
    expect(unknownMode.statusCode).toBe(400)
    expect(stored()).toBeUndefined()
  })

  it('apply manages it only when the spec carries it, and export round-trips it', async () => {
    const spec = { displayName: 'Acme', canonicalDomain: 'acme.com', country: 'US', language: 'en', providers: ['claude', 'openai'] }
    const config = (extra: Record<string, unknown> = {}) => ({ apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'acme' }, spec: { ...spec, ...extra } })

    const applied = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: config({ providerDispatchModes: { claude: 'batch' } }) })
    expect(applied.statusCode).toBe(200)
    expect(applied.json().providerDispatchModes).toEqual({ claude: 'batch' })

    const converged = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: config() })
    expect(converged.json().providerDispatchModes).toEqual({ claude: 'batch' })

    const exported = (await app.inject({ method: 'GET', url: '/api/v1/projects/acme/export' })).json()
    expect(exported.spec.providerDispatchModes).toEqual({ claude: 'batch' })

    const cleared = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: config({ providerDispatchModes: {} }) })
    expect(cleared.json().providerDispatchModes).toEqual({})
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/acme/export' })).json().spec).not.toHaveProperty('providerDispatchModes')

    const invalid = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: config({ providerDispatchModes: { mistral: 'batch' } }) })
    expect(invalid.statusCode).toBe(400)
  })
})
