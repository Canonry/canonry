/**
 * `createServer` is the only place that turns the Aero managed-sweeps guard
 * on. The registry and tool-builder tests prove what the guard does; this
 * proves the server derives the flag from the managed run kinds, including
 * the legacy aliases, and hands it to the registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import type { CanonryConfig } from '../src/config.js'

const captured = vi.hoisted(() => [] as Array<{ managedSweeps?: boolean }>)

vi.mock('../src/agent/session-registry.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/agent/session-registry.js')>()
  class CapturingSessionRegistry extends mod.SessionRegistry {
    constructor(opts: ConstructorParameters<typeof mod.SessionRegistry>[0]) {
      captured.push(opts)
      super(opts)
    }
  }
  return { ...mod, SessionRegistry: CapturingSessionRegistry }
})

const MANAGED_ENV = [
  'CANONRY_DASHBOARD_MANAGED_RUN_KINDS',
  'CANONRY_DASHBOARD_MANAGED_SWEEPS',
  'CANONRY_AGENT_DISABLED',
] as const

describe('createServer managed sweeps for Aero', () => {
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    captured.length = 0
    for (const key of MANAGED_ENV) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of MANAGED_ENV) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it.each([
    { env: {}, dashboard: undefined, expected: false },
    { env: { CANONRY_DASHBOARD_MANAGED_RUN_KINDS: 'answer-visibility' }, dashboard: undefined, expected: true },
    { env: { CANONRY_DASHBOARD_MANAGED_RUN_KINDS: 'site-audit' }, dashboard: undefined, expected: false },
    { env: { CANONRY_DASHBOARD_MANAGED_SWEEPS: '1' }, dashboard: undefined, expected: true },
    { env: {}, dashboard: { managedRunKinds: ['answer-visibility', 'site-audit'] }, expected: true },
    { env: {}, dashboard: { managedRunKinds: ['site-audit'] }, expected: false },
    { env: {}, dashboard: { managedSweeps: true }, expected: true },
  ] as const)('env $env, dashboard $dashboard -> managedSweeps $expected', async ({ env, dashboard, expected }) => {
    Object.assign(process.env, env)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-aero-managed-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createClient(dbPath)
    migrate(db)
    const app = await createServer({
      config: {
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: `cnry_${crypto.randomBytes(16).toString('hex')}`,
        providers: {},
        ...(dashboard ? { dashboard } : {}),
      } as CanonryConfig,
      db,
      logger: false,
    })
    try {
      expect(captured).toHaveLength(1)
      expect(captured[0]?.managedSweeps).toBe(expected)
    } finally {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
