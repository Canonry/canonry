import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerRequestContext, type ApiRequestCompletedInfo } from '../src/request-context.js'

const apps: Array<ReturnType<typeof Fastify>> = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

function appWith(onRequestCompleted: (info: ApiRequestCompletedInfo) => void) {
  const app = Fastify()
  apps.push(app)
  registerRequestContext(app, { onRequestCompleted })
  app.get('/projects/:name', async () => ({ ok: true }))
  return app
}

describe('request completion usage hook', () => {
  it('reports the route template, outcome, and usage labels once, never the concrete URL', async () => {
    const seen: ApiRequestCompletedInfo[] = []
    const app = appWith(info => seen.push(info))

    const response = await app.inject({
      method: 'GET',
      url: '/projects/acme-client-secret?token=abc',
      headers: {
        'user-agent': 'canonry-mcp',
        'x-canonry-actor-session': 'session-1',
        'x-canonry-surface': 'mcp-stdio',
        'x-canonry-agent': 'claude',
        'x-canonry-mcp-tool': 'canonry_project_overview',
        'x-canonry-mcp-call': '4f8c2a1e-9b3d-4c7a-8e21-5d6f7a8b9c0d',
        'x-canonry-mcp-client': 'claude-code',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      method: 'GET',
      route: '/projects/:name',
      statusCode: 200,
      durationMs: expect.any(Number),
      userAgent: 'canonry-mcp',
      actorSession: 'session-1',
      principalKind: undefined,
      usageLabels: {
        surface: 'mcp-stdio',
        agent: 'claude',
        mcpTool: 'canonry_project_overview',
        mcpCall: '4f8c2a1e-9b3d-4c7a-8e21-5d6f7a8b9c0d',
        mcpClient: 'claude-code',
      },
    })
    expect(JSON.stringify(seen)).not.toContain('acme-client-secret')
    expect(JSON.stringify(seen)).not.toContain('token')
  })

  it('does not report a request that matched no route', async () => {
    const seen: ApiRequestCompletedInfo[] = []
    const app = appWith(info => seen.push(info))

    const response = await app.inject({ method: 'GET', url: '/nowhere' })

    expect(response.statusCode).toBe(404)
    expect(seen).toEqual([])
  })

  it('never lets a failing hook change the response', async () => {
    const app = appWith(() => { throw new Error('telemetry exploded') })

    const response = await app.inject({ method: 'GET', url: '/projects/a' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })
})

describe('request error codes', () => {
  it('reports the stable code of a thrown error, never its message', async () => {
    const seen: ApiRequestCompletedInfo[] = []
    const app = Fastify()
    apps.push(app)
    registerRequestContext(app, { onRequestCompleted: info => seen.push(info) })
    app.get('/projects/:name/backlinks', async () => {
      throw Object.assign(new Error('backlinks for acme.example are not installed'), { code: 'NOT_FOUND', statusCode: 404 })
    })
    app.get('/projects/:name', async () => ({ ok: true }))
    await app.inject({ method: 'GET', url: '/projects/acme/backlinks' })
    await app.inject({ method: 'GET', url: '/projects/acme' })
    expect(seen[0]).toMatchObject({ statusCode: 404, errorCode: 'NOT_FOUND' })
    expect(JSON.stringify(seen[0])).not.toContain('acme')
    expect(seen[1]).not.toHaveProperty('errorCode')
  })

  it('ignores codes that are not stable identifiers', async () => {
    const seen: ApiRequestCompletedInfo[] = []
    const app = Fastify()
    apps.push(app)
    registerRequestContext(app, { onRequestCompleted: info => seen.push(info) })
    app.get('/x', async () => { throw Object.assign(new Error('x'), { code: 'not a code', statusCode: 500 }) })
    await app.inject({ method: 'GET', url: '/x' })
    expect(seen[0]).not.toHaveProperty('errorCode')
  })
})
