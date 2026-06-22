import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import type { CanonryConfig } from '../src/config.js'

const AGENT_ENV = ['CANONRY_AGENT_DISABLED'] as const

interface Built {
  app: Awaited<ReturnType<typeof createServer>>
  apiKey: string
  cleanup: () => Promise<void>
}

async function buildServer(agent?: CanonryConfig['agent']): Promise<Built> {
  const tmpDir = path.join(os.tmpdir(), `canonry-agent-disabled-${crypto.randomUUID()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const dbPath = path.join(tmpDir, 'test.db')
  const db: DatabaseClient = createClient(dbPath)
  migrate(db)

  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const config: CanonryConfig = {
    apiUrl: 'http://localhost:4100',
    database: dbPath,
    apiKey,
    providers: {},
    ...(agent ? { agent } : {}),
  }

  const app = await createServer({ config, db, logger: false })
  return {
    app,
    apiKey,
    cleanup: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

async function seedProject(app: Built['app'], apiKey: string, name: string): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${name}`,
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { displayName: name, canonicalDomain: `${name}.example.com`, country: 'US', language: 'en' },
  })
  expect(res.statusCode).toBe(201)
}

describe('Aero agent kill-switch', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of AGENT_ENV) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of AGENT_ENV) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('enabled (default): the agent transcript route is served (200 for a real project)', async () => {
    const { app, apiKey, cleanup } = await buildServer()
    try {
      await seedProject(app, apiKey, 'acme')
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/acme/agent/transcript',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).messages).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('config agent.mode "disabled": agent routes are NOT served (404 for a real project)', async () => {
    const { app, apiKey, cleanup } = await buildServer({ mode: 'disabled' })
    try {
      // The project EXISTS, so a 404 proves the route was never registered
      // (not a project-not-found 404).
      await seedProject(app, apiKey, 'acme')
      const auth = { authorization: `Bearer ${apiKey}` }

      const transcript = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/agent/transcript', headers: auth })
      expect(transcript.statusCode).toBe(404)

      // The SSE prompt route — the one that spends on Opus — is gone too.
      const prompt = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/acme/agent/prompt',
        headers: auth,
        payload: { prompt: 'hi' },
      })
      expect(prompt.statusCode).toBe(404)
    } finally {
      await cleanup()
    }
  })

  it('CANONRY_AGENT_DISABLED=1 overrides config and disables the routes', async () => {
    process.env.CANONRY_AGENT_DISABLED = '1'
    // config does NOT disable — env must win.
    const { app, apiKey, cleanup } = await buildServer()
    try {
      await seedProject(app, apiKey, 'acme')
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/acme/agent/transcript',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      expect(res.statusCode).toBe(404)
    } finally {
      await cleanup()
    }
  })

  it('CANONRY_AGENT_DISABLED=0 forces the agent ON even when config disables it', async () => {
    process.env.CANONRY_AGENT_DISABLED = '0'
    const { app, apiKey, cleanup } = await buildServer({ mode: 'disabled' })
    try {
      await seedProject(app, apiKey, 'acme')
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/acme/agent/transcript',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await cleanup()
    }
  })
})
