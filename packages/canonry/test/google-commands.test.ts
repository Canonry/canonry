import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'

describe('google CLI commands', { concurrency: 1 }, () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-google-cmd-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')

    const db = createClient(dbPath)
    migrate(db)

    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const hashed = crypto.createHash('sha256').update(apiKeyPlain).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: hashed,
      keyPrefix: apiKeyPlain.slice(0, 8),
      createdAt: new Date().toISOString(),
    }).run()

    const now = new Date().toISOString()
    const gscConn = {
      domain: 'example.com',
      connectionType: 'gsc' as const,
      propertyId: 'sc-domain:example.com',
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: [],
      createdAt: now,
      updatedAt: now,
    }

    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: {},
      google: {
        clientId: 'fake-client-id',
        clientSecret: 'fake-client-secret',
        connections: [gscConn],
      },
    }

    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({
      config: config as Parameters<typeof createServer>[0]['config'],
      db,
      logger: false,
    })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const serverUrl = `http://127.0.0.1:${port}`

    config.apiUrl = serverUrl
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    close = () => app.close()
    client = new ApiClient(serverUrl, apiKeyPlain)
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = origConfigDir
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('googleCoverage prints "No URL inspections found" when project has no inspections', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { googleCoverage } = await import('../src/commands/google.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await googleCoverage('test-proj')
    } finally {
      console.log = origLog
    }

    assert.match(logs.join('\n'), /No URL inspections found/)
  })

  it('googleCoverage outputs valid JSON with summary when format is json', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { googleCoverage } = await import('../src/commands/google.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await googleCoverage('test-proj', 'json')
    } finally {
      console.log = origLog
    }

    const parsed = JSON.parse(logs.join('\n')) as { summary: { total: number } }
    assert.ok('summary' in parsed, 'JSON output should contain a summary field')
    assert.equal(parsed.summary.total, 0)
  })

  it('googleInspectSitemap prints run ID after queuing', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { googleInspectSitemap } = await import('../src/commands/google.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await googleInspectSitemap('test-proj', { wait: false })
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    assert.match(output, /Sitemap inspection started/)
  })
})
