import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { apiKeys, createClient, migrate } from '@ainyc/canonry-db'

const setTelemetryPreference = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/telemetry.js')>(),
  setTelemetryPreference,
}))

const { createServer } = await import('../src/server.js')

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const step of cleanup.splice(0).reverse()) await step()
})

it('attributes an opt-out through PUT /telemetry to the surface and agent of the request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-telemetry-optout-'))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const database = path.join(dir, 'data.db')
  const db = createClient(database)
  migrate(db)
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: 'operator-key', name: 'default', scopes: ['*'], createdAt: '2026-10-09T00:00:00.000Z',
    keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'), keyPrefix: apiKey.slice(0, 9),
  }).run()
  vi.stubEnv('CANONRY_OPERATOR_KEY_IDS', 'operator-key')
  const app = await createServer({ config: { apiUrl: 'http://127.0.0.1:4100', database, apiKey, providers: {} }, db, logger: false })
  cleanup.push(() => app.close())

  const res = await app.inject({
    method: 'PUT',
    url: '/api/v1/telemetry',
    payload: { enabled: false },
    headers: { authorization: `Bearer ${apiKey}`, 'user-agent': 'canonry-mcp', 'x-canonry-surface': 'mcp-stdio', 'x-canonry-agent': 'Claude Code' },
  })

  expect(res.statusCode).toBe(200)
  expect(setTelemetryPreference).toHaveBeenCalledExactlyOnceWith(false, 'api', { surface: 'mcp-stdio', agent: 'claude-code' })
})
