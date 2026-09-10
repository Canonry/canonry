import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiKeys,
  createClient,
  migrate,
  projects,
  researchRuns,
  runs,
  users,
} from '@ainyc/canonry-db'
import { apiRoutes, hashApiKey, hashUserPassword, type ApiRoutesOptions } from '../src/index.js'
import { USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'
const VIEWER_PASSWORD = 'a-long-enough-viewer-password'
const ROOT_KEY = 'cnry_research_root'
const READ_KEY = 'cnry_research_read'
const UNRELATED_KEY = 'cnry_research_unrelated'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function seedKey(
  db: ReturnType<typeof createClient>,
  id: string,
  token: string,
  scopes: string[],
): void {
  db.insert(apiKeys).values({
    id,
    name: id,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    createdAt: new Date().toISOString(),
  }).run()
}

function keyHeaders(token: string) {
  return { authorization: `Bearer ${token}` }
}

function cookieHeaders(sessionId: string) {
  return {
    cookie: `${USER_SESSION_COOKIE_NAME}=${sessionId}`,
    origin: ORIGIN,
    host: HOST,
  }
}

async function signIn(app: ReturnType<typeof Fastify>, name: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { name, password },
  })
  expect(response.statusCode).toBe(200)
  const raw = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'][0]!
    : String(response.headers['set-cookie'])
  return decodeURIComponent(raw.split(';')[0]!.split('=')[1]!)
}

async function harness(allowViewers: boolean, viewerDailyRunLimit = 20) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-viewer-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  for (const name of ['alpha', 'beta']) {
    db.insert(projects).values({
      id: name,
      name,
      displayName: name,
      canonicalDomain: `${name}.example`,
      country: 'US',
      language: 'en',
      providers: ['openai'],
      createdAt: now,
      updatedAt: now,
    }).run()
  }
  seedKey(db, 'root-key', ROOT_KEY, ['*'])
  seedKey(db, 'read-key', READ_KEY, ['read'])
  seedKey(db, 'unrelated-key', UNRELATED_KEY, ['users.read'])
  db.insert(users).values([
    {
      id: 'admin-user',
      name: 'admin',
      nameKey: 'admin',
      passwordHash: await hashUserPassword(ADMIN_PASSWORD),
      role: 'admin',
      createdAt: now,
    },
    {
      id: 'viewer-user',
      name: 'viewer',
      nameKey: 'viewer',
      passwordHash: await hashUserPassword(VIEWER_PASSWORD),
      role: 'viewer',
      createdAt: now,
    },
  ]).run()

  const requested = vi.fn()
  const app = Fastify()
  const routeOptions = {
    db,
    researchAllowViewers: allowViewers,
    researchViewerDailyRunLimit: viewerDailyRunLimit,
    onResearchRunRequested: requested,
    getRunnableProviderNames: () => ['openai'],
    providerSummary: [{ name: 'openai', configured: true }],
    providerAdapters: [{
      name: 'openai',
      displayName: 'OpenAI',
      mode: 'api' as const,
      modelConfigurable: true,
      defaultModel: 'gpt-5-mini',
      knownModels: [{ id: 'gpt-5-mini', displayName: 'GPT-5 mini', tier: 'fast' as const }],
      modelValidationPattern: /^gpt-[\w.-]+$/,
      modelValidationHint: 'OpenAI model ID',
    }],
  } as ApiRoutesOptions & {
    researchAllowViewers: boolean
    researchViewerDailyRunLimit: number
  }
  app.register(apiRoutes, routeOptions)
  await app.ready()
  const admin = await signIn(app, 'admin', ADMIN_PASSWORD)
  const viewer = await signIn(app, 'viewer', VIEWER_PASSWORD)

  cleanups.push(async () => {
    await app.close()
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  return { app, db, requested, admin, viewer }
}

function researchRequest(idempotencyKey: string) {
  return {
    queries: ['Which AEO platform fits an agency?'],
    provider: 'openai',
    model: 'gpt-5-mini',
    idempotencyKey,
  }
}

function researchBatchRequest(idempotencyKey: string, destinations = 2) {
  return {
    idempotencyKey,
    runs: Array.from({ length: destinations }, (_, index) => ({
      queries: [`Which AEO platform fits agency destination ${index + 1}?`],
      provider: 'openai', model: 'gpt-5-mini', location: null,
    })),
  }
}

describe('viewer research grants', () => {
  it('keeps answer-visibility sweeps forbidden when viewer research is enabled', async () => {
    const { app, db, viewer } = await harness(true)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/runs',
      headers: cookieHeaders(viewer),
      payload: {},
    })

    expect(response.statusCode).toBe(403)
    expect(db.select().from(runs).all()).toEqual([])
  })

  it('refuses viewer research unless the deployment opted in', async () => {
    const { app, db, viewer } = await harness(false)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/research/runs',
      headers: cookieHeaders(viewer),
      payload: researchRequest('viewer-off'),
    })

    expect(response.statusCode).toBe(403)
    expect(db.select().from(researchRuns).all()).toEqual([])
  })

  it('keeps history cleanup forbidden for research viewers and read-only keys', async () => {
    const { app, viewer } = await harness(true)
    for (const headers of [cookieHeaders(viewer), keyHeaders(READ_KEY), keyHeaders(UNRELATED_KEY)]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/projects/alpha/results/clear', headers, payload: { runIds: ['saved-run'], confirm: true } })
      expect(response.statusCode).toBe(403)
    }
  })

  it('offers safe model choices without giving a viewer settings access or starting work', async () => {
    const { app, db, viewer, requested } = await harness(true)
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/alpha/research/runs', headers: cookieHeaders(viewer) })
    expect(response.statusCode).toBe(200)
    expect(response.json().providers).toEqual([{
      name: 'openai', displayName: 'OpenAI', modelConfigurable: true,
      defaultModel: 'gpt-5-mini', knownModels: [{ id: 'gpt-5-mini', displayName: 'GPT-5 mini' }],
    }])
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings', headers: cookieHeaders(viewer) })).statusCode).toBe(403)
    expect(requested).not.toHaveBeenCalled()
    expect(db.select().from(researchRuns).all()).toEqual([])
  })

  it('allows and attributes viewer research after opt-in', async () => {
    const { app, db, viewer } = await harness(true)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/research/runs',
      headers: cookieHeaders(viewer),
      payload: researchRequest('viewer-on'),
    })

    expect(response.statusCode).toBe(202)
    expect(response.json().initiatedBy).toEqual({
      kind: 'user',
      id: 'viewer-user',
      name: 'viewer',
      role: 'viewer',
    })
    expect(db.select().from(researchRuns).get()?.initiatedBy).toEqual(response.json().initiatedBy)
  })

  it.each([
    ['read-only', READ_KEY],
    ['unrelated', UNRELATED_KEY],
  ])('refuses a %s API key even when viewer research is enabled', async (_label, token) => {
    const { app, db } = await harness(true)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/research/runs',
      headers: keyHeaders(token),
      payload: researchRequest(`key-${token}`),
    })

    expect(response.statusCode).toBe(403)
    expect(db.select().from(researchRuns).all()).toEqual([])
  })

  it('applies the same paid-write and read-only guards to multi-destination research', async () => {
    const { app, db } = await harness(true)
    for (const token of [READ_KEY, UNRELATED_KEY]) {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/projects/alpha/research/batches', headers: keyHeaders(token),
        payload: researchBatchRequest(`blocked-${token}`, 1),
      })
      expect(response.statusCode).toBe(403)
    }
    expect(db.select().from(researchRuns).all()).toEqual([])
  })

  it.each([false, true])('leaves administrator research unchanged when allowViewers=%s', async allowViewers => {
    const { app, admin } = await harness(allowViewers)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/research/runs',
      headers: cookieHeaders(admin),
      payload: researchRequest(`admin-${allowViewers}`),
    })

    expect(response.statusCode).toBe(202)
    expect(response.json().initiatedBy).toEqual({
      kind: 'user',
      id: 'admin-user',
      name: 'admin',
      role: 'admin',
    })
  })

  it('caps viewer-created runs per project and UTC day without counting administrators', async () => {
    const { app, db, admin, viewer } = await harness(true, 2)
    const create = (project: string, session: string, key: string) => app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project}/research/runs`,
      headers: cookieHeaders(session),
      payload: researchRequest(key),
    })

    expect((await create('alpha', viewer, 'viewer-1')).statusCode).toBe(202)
    expect((await create('alpha', admin, 'admin-1')).statusCode).toBe(202)
    expect((await create('alpha', viewer, 'viewer-2')).statusCode).toBe(202)

    const limited = await create('alpha', viewer, 'viewer-3')
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({
      error: {
        code: 'RESEARCH_DAILY_LIMIT_EXCEEDED',
        details: { projectName: 'alpha', limit: 2 },
      },
    })
    expect(limited.json().error.message).toMatch(/research run limit.*today/i)

    expect((await create('beta', viewer, 'viewer-beta')).statusCode).toBe(202)
    expect(db.select().from(researchRuns).all()).toHaveLength(4)
  })

  it('returns an idempotent viewer retry even after the daily cap is full', async () => {
    const { app, viewer } = await harness(true, 1)
    const request = {
      method: 'POST' as const,
      url: '/api/v1/projects/alpha/research/runs',
      headers: cookieHeaders(viewer),
      payload: researchRequest('same-request'),
    }

    const first = await app.inject(request)
    const retry = await app.inject(request)

    expect(first.statusCode).toBe(202)
    expect(retry.statusCode).toBe(200)
    expect(retry.json().id).toBe(first.json().id)
  })

  it('counts every multi-destination child against the viewer daily cap atomically', async () => {
    const { app, db, viewer, requested } = await harness(true, 3)
    const firstRequest = {
      method: 'POST' as const, url: '/api/v1/projects/alpha/research/batches',
      headers: cookieHeaders(viewer), payload: researchBatchRequest('viewer-batch-one'),
    }
    const first = await app.inject(firstRequest)
    expect(first.statusCode).toBe(202)
    expect(first.json().runs).toHaveLength(2)
    expect(requested).toHaveBeenCalledTimes(2)
    const limited = await app.inject({ ...firstRequest, payload: researchBatchRequest('viewer-batch-two') })
    expect(limited.statusCode).toBe(429)
    expect(db.select().from(researchRuns).all()).toHaveLength(2)
    const replay = await app.inject(firstRequest)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().runs.map((run: { id: string }) => run.id)).toEqual(first.json().runs.map((run: { id: string }) => run.id))
  })

  it('does not grant a viewer access to instance settings', async () => {
    const { app, viewer } = await harness(true)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: cookieHeaders(viewer),
    })

    expect(response.statusCode).toBe(403)
  })

  it('attributes a wildcard API-key run without widening narrower keys', async () => {
    const { app } = await harness(true)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/research/runs',
      headers: keyHeaders(ROOT_KEY),
      payload: researchRequest('root-key-run'),
    })

    expect(response.statusCode).toBe(202)
    expect(response.json().initiatedBy).toEqual({
      kind: 'api-key',
      id: 'root-key',
      name: 'root-key',
      role: null,
    })
  })
})
