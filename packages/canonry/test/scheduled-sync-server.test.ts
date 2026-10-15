import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import cron from 'node-cron'
import { expect, it, vi } from 'vitest'
import { createClient, migrate, projects, runs, schedules, apiKeys } from '@canonry/canonry-db'
import { createServer, waitForServerRuntimeStartup } from '../src/server.js'
import type { CanonryConfig } from '../src/config.js'
import { invokeCli } from './cli-test-utils.js'

it('stores scheduled host refreshes and manual CLI syncs, including after a refused refresh', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-scheduled-sync-server-'))
  const database = path.join(tmp, 'test.db')
  const db = createClient(database); migrate(db)
  const apiKey = 'cnry_synthetic_scheduler_key', now = new Date().toISOString()
  db.insert(projects).values({ id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'example.test', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  db.insert(apiKeys).values({ id: 'key', name: 'test', keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'), keyPrefix: 'cnry_', scopes: ['*'], createdAt: now }).run()
  const expression = '17 */6 * * *'
  db.insert(schedules).values({ id: 'refresh', projectId: 'project', kind: 'data-refresh', cronExpr: expression, timezone: 'UTC', enabled: true, providers: [], createdAt: now, updatedAt: now }).run()
  const callbacks = new Map<string, () => unknown>()
  const schedule = vi.spyOn(cron, 'schedule').mockImplementation((expr, task, options) => {
    if (typeof task !== 'function') throw new Error('Expected an in-process cron callback')
    callbacks.set(expr, () => Reflect.apply(task, undefined, []))
    return cron.createTask(expr, task, options)
  })
  const socket = net.createServer()
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const address = socket.address()
  if (!address || typeof address === 'string') throw new Error('Expected local TCP address')
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  const connection = { domain: 'example.test', connectionType: 'gsc' as const, propertyId: 'sc-domain:example.test', createdAt: now, updatedAt: now }
  // A stored connection is enough to admit the run. Missing OAuth credentials
  // make the host finish it locally without starting provider work.
  const config: CanonryConfig = { apiUrl: `http://127.0.0.1:${address.port}`, database, apiKey, providers: {}, google: { connections: [connection] } }
  fs.writeFileSync(path.join(tmp, 'config.yaml'), JSON.stringify(config))
  vi.stubEnv('CANONRY_CONFIG_DIR', tmp); vi.stubEnv('DO_NOT_TRACK', '1'); vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1'); vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
  const app = await createServer({ config, db, logger: false })
  let scheduledResponses = 0
  app.addHook('onResponse', async request => { if (request.method === 'POST' && request.headers['x-canonry-surface'] === 'system') scheduledResponses++ })
  try {
    await app.listen({ host: '127.0.0.1', port: address.port }); await waitForServerRuntimeStartup(app)
    expect(callbacks.has(expression)).toBe(true)
    callbacks.get(expression)!()
    await vi.waitFor(() => expect(scheduledResponses).toBe(7), { timeout: 10_000 })
    let rows = db.select().from(runs).all().filter(row => row.kind === 'gsc-sync')
    expect(rows).toHaveLength(1); expect(rows[0]!.trigger).toBe('scheduled')
    const firstId = rows[0]!.id
    const manual = await invokeCli(['google', 'sync', 'example', '--format', 'json'])
    expect(manual.exitCode, manual.stderr).toBeUndefined()
    rows = db.select().from(runs).all().filter(row => row.kind === 'gsc-sync')
    expect(rows).toHaveLength(2); expect(rows.find(row => row.id !== firstId)?.trigger).toBe('manual')
    config.google!.connections = []
    callbacks.get(expression)!()
    await vi.waitFor(() => expect(scheduledResponses).toBe(14), { timeout: 10_000 })
    expect(db.select().from(runs).all().filter(row => row.kind === 'gsc-sync')).toHaveLength(2)
    config.google!.connections = [connection]
    const afterRefusal = await invokeCli(['google', 'sync', 'example', '--format', 'json'])
    expect(afterRefusal.exitCode, afterRefusal.stderr).toBeUndefined()
    rows = db.select().from(runs).all().filter(row => row.kind === 'gsc-sync')
    expect(rows).toHaveLength(3); expect(rows.filter(row => row.trigger === 'manual')).toHaveLength(2)
  } finally { await app.close(); schedule.mockRestore(); vi.unstubAllEnvs(); db.$client.close(); fs.rmSync(tmp, { recursive: true, force: true }) }
})
