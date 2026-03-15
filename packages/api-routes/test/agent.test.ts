import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts })

  return { app, tmpDir }
}

describe('agent routes', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  before(async () => {
    const ctx = buildApp({
      onAgentMessage: async (_projectId, _threadId, message) => `Echo: ${message}`,
    })
    app = ctx.app
    tmpDir = ctx.tmpDir
    await app.ready()

    for (const name of ['alpha', 'beta']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${name}`,
        payload: {
          displayName: name.toUpperCase(),
          canonicalDomain: `${name}.example.com`,
          country: 'US',
          language: 'en',
        },
      })
      assert.equal(res.statusCode, 201)
    }
  })

  after(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('keeps threads scoped to the requested project', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/alpha/agent/threads',
      payload: { title: 'Alpha thread' },
    })
    assert.equal(create.statusCode, 201)
    const thread = create.json() as { id: string }

    const getSameProject = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/alpha/agent/threads/${thread.id}`,
    })
    assert.equal(getSameProject.statusCode, 200)

    const getOtherProject = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/beta/agent/threads/${thread.id}`,
    })
    assert.equal(getOtherProject.statusCode, 404)

    const postOtherProject = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/beta/agent/threads/${thread.id}/messages`,
      payload: { message: 'hello' },
    })
    assert.equal(postOtherProject.statusCode, 404)

    const deleteOtherProject = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/beta/agent/threads/${thread.id}`,
    })
    assert.equal(deleteOtherProject.statusCode, 404)

    const stillExists = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/alpha/agent/threads/${thread.id}`,
    })
    assert.equal(stillExists.statusCode, 200)
  })

  it('returns 503 when the agent becomes unavailable at request time', async () => {
    const unavailableApp = buildApp({
      onAgentMessage: async () => {
        const err = new Error('Agent is not configured. Add a provider with an API key.') as Error & { code: string }
        err.code = 'AGENT_UNAVAILABLE'
        throw err
      },
    })

    try {
      await unavailableApp.app.ready()

      const projectRes = await unavailableApp.app.inject({
        method: 'PUT',
        url: '/api/v1/projects/gamma',
        payload: {
          displayName: 'Gamma',
          canonicalDomain: 'gamma.example.com',
          country: 'US',
          language: 'en',
        },
      })
      assert.equal(projectRes.statusCode, 201)

      const create = await unavailableApp.app.inject({
        method: 'POST',
        url: '/api/v1/projects/gamma/agent/threads',
        payload: {},
      })
      assert.equal(create.statusCode, 201)
      const thread = create.json() as { id: string }

      const send = await unavailableApp.app.inject({
        method: 'POST',
        url: `/api/v1/projects/gamma/agent/threads/${thread.id}/messages`,
        payload: { message: 'hello' },
      })
      assert.equal(send.statusCode, 503)
      assert.equal(send.json().error.code, 'AGENT_UNAVAILABLE')
    } finally {
      await unavailableApp.app.close()
      fs.rmSync(unavailableApp.tmpDir, { recursive: true, force: true })
    }
  })
})
