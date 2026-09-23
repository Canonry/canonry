import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { apiKeys, createClient, migrate } from '@ainyc/canonry-db'
import { initCommand } from '../src/commands/init.js'
import { bootstrapCommand } from '../src/commands/bootstrap.js'
import { loadConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('init accepts the Muse key flag and persists the default measurement model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-muse-init-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  try {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await initCommand({ museKey: 'muse-flag-key', skipSkills: true, skipMcp: true, format: 'json' })
    expect(loadConfig().providers?.muse).toMatchObject({
      apiKey: 'muse-flag-key', model: 'muse-spark-1.3',
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('bootstrap stores MUSE_API_KEY and never treats the generic MODEL_API_KEY as a Muse key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-muse-bootstrap-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  vi.stubEnv('MUSE_API_KEY', undefined as unknown as string)
  vi.stubEnv('MODEL_API_KEY', 'other-tool-key')
  try {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await bootstrapCommand({ format: 'json' })
    expect(loadConfig().providers?.muse).toBeUndefined()
    vi.stubEnv('MUSE_API_KEY', 'canonical-key')
    await bootstrapCommand({ format: 'json' })
    expect(loadConfig().providers?.muse?.apiKey).toBe('canonical-key')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('local server registers configured Muse for settings and project writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-muse-server-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const database = path.join(dir, 'test.db')
  const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const db = createClient(database)
  migrate(db)
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'test', keyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
    keyPrefix: apiKey.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString(),
  }).run()
  const config = {
    apiUrl: 'http://localhost:4100', database, apiKey,
    providers: { muse: { apiKey: 'muse-test-key', model: 'muse-spark-1.3' } },
  }
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    app = await createServer({ config, db, logger: false, assetsDir: path.join(dir, 'assets') })
    const headers = { authorization: `Bearer ${apiKey}` }
    const settings = await app.inject({ url: '/api/v1/settings', headers })
    expect(settings.statusCode).toBe(200)
    expect(settings.json().providers).toContainEqual(expect.objectContaining({
      name: 'muse', configured: true, model: 'muse-spark-1.3',
    }))
    const project = await app.inject({
      method: 'PUT', url: '/api/v1/projects/muse-project', headers,
      payload: { displayName: 'Muse Project', canonicalDomain: 'example.com', country: 'US', language: 'en', providers: ['muse'] },
    })
    expect(project.statusCode).toBe(201)
    expect(project.json().providers).toEqual(['muse'])
  } finally {
    await app?.close()
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
