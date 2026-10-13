import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import type { CanonryConfig } from '../src/config.js'

// The server owns the daily `install.state` loop: it starts once the listener
// is live, stops with the server, and never runs for an embedded read-only render.

const installState = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock('../src/install-state-telemetry.js', () => ({ startInstallStateTelemetry: installState.start }))
const { createServer, waitForServerRuntimeStartup } = await import('../src/server.js')

beforeEach(() => {
  installState.start.mockReset().mockReturnValue(installState.stop)
  installState.stop.mockReset()
})

async function listening(extra: Partial<CanonryConfig> = {}): Promise<{ app: Awaited<ReturnType<typeof createServer>>; db: DatabaseClient; config: CanonryConfig }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-install-state-server-'))
  const database = path.join(dir, 'test.db')
  const db = createClient(database)
  migrate(db)
  const config: CanonryConfig = { apiUrl: 'http://localhost:4100', database, apiKey: `cnry_${crypto.randomBytes(16).toString('hex')}`, providers: {}, ...extra }
  const app = await createServer({ config, db, logger: false })
  onTestFinished(async () => {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { app, db, config }
}

it('starts the daily report once the listener is live, and stops it when the server closes', async () => {
  const { app, db, config } = await listening()
  expect(installState.start).not.toHaveBeenCalled()

  await app.listen({ host: '127.0.0.1', port: 0 })
  await waitForServerRuntimeStartup(app)
  expect(installState.start).toHaveBeenCalledExactlyOnceWith({ db, config, agentEnabled: true, isBacklinksInstalled: expect.any(Function) })
  expect(installState.stop).not.toHaveBeenCalled()

  await app.close()
  expect(installState.stop).toHaveBeenCalledTimes(1)
})

it('never starts it for an embedded read-only render', async () => {
  const { app } = await listening({ embed: { enabled: true } })
  await app.listen({ host: '127.0.0.1', port: 0 })
  await waitForServerRuntimeStartup(app)
  expect(installState.start).not.toHaveBeenCalled()
})
