import Fastify from 'fastify'
import { afterEach, describe, expect, test } from 'vitest'
import { operationalLogsRoutes } from '../src/operational-logs.js'

type Credential = { scopes: string[]; projectId?: string; role?: 'admin' | 'viewer' }

async function build(callback?: Parameters<typeof operationalLogsRoutes>[1]['listOperationalLogs']) {
  const app = Fastify()
  app.addHook('onRequest', async (request) => {
    const encoded = request.headers['x-test-credential']
    if (typeof encoded !== 'string') return
    const credential = JSON.parse(encoded) as Credential
    if (credential.role) {
      request.principal = {
        kind: 'user', id: 'user_1', name: 'user', scopes: credential.scopes,
        projectId: null, role: credential.role, viaCookie: false,
      }
    } else {
      request.apiKey = { id: 'key_1', name: 'key', scopes: credential.scopes, projectId: credential.projectId ?? null }
      request.principal = {
        kind: 'api-key', id: 'key_1', name: 'key', scopes: credential.scopes,
        projectId: credential.projectId ?? null, viaCookie: false,
      }
      request.operatorAccess = true // This route-only harness models a host-approved bearer.
    }
  })
  await app.register(operationalLogsRoutes, { listOperationalLogs: callback })
  await app.ready()
  return app
}

const wildcard = { 'x-test-credential': JSON.stringify({ scopes: ['*'] }) }

describe('GET /operations/logs', () => {
  const apps: Array<Awaited<ReturnType<typeof build>>> = []
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

  test('rejects read, research, project-scoped, and viewer credentials', async () => {
    const app = await build(() => emptyResult())
    apps.push(app)
    for (const credential of [
      { scopes: ['read'] },
      { scopes: ['research.run'] },
      { scopes: ['*'], projectId: 'project_1' },
      { scopes: ['*'], role: 'viewer' },
    ]) {
      const response = await app.inject({
        method: 'GET', url: '/operations/logs',
        headers: { 'x-test-credential': JSON.stringify(credential) },
      })
      expect(response.statusCode).toBe(403)
    }
  })

  test('validates malformed filters and returns 501 without a host callback', async () => {
    const app = await build()
    apps.push(app)
    for (const url of ['/operations/logs?limit=0', '/operations/logs?limit=wat', '/operations/logs?unexpected=value']) {
      const response = await app.inject({ method: 'GET', url, headers: wildcard })
      expect(response.statusCode).toBe(400)
    }
    const unsupported = await app.inject({ method: 'GET', url: '/operations/logs', headers: wildcard })
    expect(unsupported.statusCode).toBe(501)
  })

  test('passes validated filters to the callback and returns its paginated process-local result', async () => {
    const calls: unknown[] = []
    const app = await build((query) => {
      calls.push(query)
      return {
        entries: [{
          cursor: 'buffer.2', ts: '2026-09-11T00:00:02.000Z', level: 'warn', module: 'Runner', action: 'run.retry',
          runId: 'run_2', projectId: 'project_1', context: { runId: 'run_2', errorCode: 'RATE_LIMIT', attempt: 2 },
        }],
        nextCursor: 'buffer.2', truncated: 4, dropped: 9, retention: 'process' as const,
        observedAt: '2026-09-11T00:00:03.000Z',
      }
    })
    apps.push(app)
    const response = await app.inject({
      method: 'GET',
      url: '/operations/logs?level=warn&module=Runner&runId=run_2&projectId=project_1&limit=1&cursor=buffer.1',
      headers: wildcard,
    })
    expect(response.statusCode).toBe(200)
    expect(calls).toEqual([{
      level: 'warn', module: 'Runner', runId: 'run_2', projectId: 'project_1', limit: 1, cursor: 'buffer.1',
    }])
    expect(response.json()).toMatchObject({ retention: 'process', truncated: 4, dropped: 9 })
  })
})

function emptyResult() {
  return {
    entries: [], nextCursor: null, truncated: 0, dropped: 0, retention: 'process' as const,
    observedAt: '2026-09-11T00:00:00.000Z',
  }
}
