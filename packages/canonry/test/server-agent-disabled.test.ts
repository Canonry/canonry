import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import type { CanonryConfig } from '../src/config.js'

const AGENT_ENV = ['CANONRY_AGENT_DISABLED'] as const

// Every route mounted by registerAgentRoutes. The kill-switch gates all of
// them through a single guard, so the test asserts the whole surface flips —
// not just the two probed before. Payloads are intentionally empty: when the
// agent is enabled, POST /prompt and the memory mutations 400 on validation
// *before* any LLM turn fires, so the parity loop never spends.
const AGENT_ROUTES: ReadonlyArray<readonly [string, string, unknown?]> = [
  ['GET', '/api/v1/projects/acme/agent/transcript'],
  ['DELETE', '/api/v1/projects/acme/agent/transcript'],
  ['GET', '/api/v1/projects/acme/agent/providers'],
  ['POST', '/api/v1/projects/acme/agent/prompt', { prompt: '' }],
  ['GET', '/api/v1/projects/acme/agent/memory'],
  ['PUT', '/api/v1/projects/acme/agent/memory', {}],
  ['DELETE', '/api/v1/projects/acme/agent/memory', {}],
] as const

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

function inject(app: Built['app'], apiKey: string, route: readonly [string, string, unknown?]) {
  const [method, url, payload] = route
  return app.inject({
    method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
    url,
    headers: { authorization: `Bearer ${apiKey}` },
    ...(payload !== undefined ? { payload } : {}),
  })
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

  it('enabled (default): the full agent route surface is served', async () => {
    const { app, apiKey, cleanup } = await buildServer()
    try {
      await seedProject(app, apiKey, 'acme')

      const transcript = await app.inject({
        method: 'GET',
        url: '/api/v1/projects/acme/agent/transcript',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      expect(transcript.statusCode).toBe(200)
      expect(JSON.parse(transcript.body).messages).toEqual([])

      // Parity with the disabled case: every gated route is mounted (not 404)
      // when the agent is on. Empty bodies keep POST /prompt + memory mutations
      // at a 400 validation error rather than running an agent turn.
      for (const route of AGENT_ROUTES) {
        const res = await inject(app, apiKey, route)
        expect(res.statusCode, `enabled ${route[0]} ${route[1]} should be mounted`).not.toBe(404)
      }
    } finally {
      await cleanup()
    }
  })

  it('config agent.mode "disabled": every agent route is gone (404 for a real project)', async () => {
    const { app, apiKey, cleanup } = await buildServer({ mode: 'disabled' })
    try {
      // The project EXISTS, so a 404 proves the route was never registered
      // (not a project-not-found 404). All 7 routes ride the single gate.
      await seedProject(app, apiKey, 'acme')
      for (const route of AGENT_ROUTES) {
        const res = await inject(app, apiKey, route)
        expect(res.statusCode, `disabled ${route[0]} ${route[1]} should 404`).toBe(404)
      }
    } finally {
      await cleanup()
    }
  })

  it('CANONRY_AGENT_DISABLED=1 overrides config and removes every agent route', async () => {
    process.env.CANONRY_AGENT_DISABLED = '1'
    // config does NOT disable — env must win.
    const { app, apiKey, cleanup } = await buildServer()
    try {
      await seedProject(app, apiKey, 'acme')
      for (const route of AGENT_ROUTES) {
        const res = await inject(app, apiKey, route)
        expect(res.statusCode, `env-disabled ${route[0]} ${route[1]} should 404`).toBe(404)
      }
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
