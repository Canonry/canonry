import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'

describe('--format json output', { concurrency: 1 }, () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let close: () => Promise<void>
  let serverUrl: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-fmt-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')

    const db = createClient(dbPath)
    migrate(db)

    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const hashed = crypto.createHash('sha256').update(apiKeyPlain).digest('hex')
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'test', keyHash: hashed, keyPrefix: apiKeyPlain.slice(0, 8), createdAt: new Date().toISOString() }).run()

    // Use port 0 for OS-assigned random port
    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: { gemini: { apiKey: 'test-key' } },
    }

    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    serverUrl = `http://127.0.0.1:${port}`

    // Rewrite config with actual port so CLI commands find the server
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

  it('showStatus with format json outputs valid JSON', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { showStatus } = await import('../src/commands/status.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showStatus('test-proj', 'json')
    } finally {
      console.log = origLog
    }

    const parsed = JSON.parse(logs.join('\n'))
    assert.ok(parsed.project)
    assert.equal(parsed.project.name, 'test-proj')
    assert.ok(Array.isArray(parsed.runs))
  })

  it('listProjects with format json outputs valid JSON array', async () => {
    await client.putProject('proj-a', {
      displayName: 'A',
      canonicalDomain: 'a.com',
      country: 'US',
      language: 'en',
    })

    const { listProjects } = await import('../src/commands/project.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listProjects('json')
    } finally {
      console.log = origLog
    }

    const parsed = JSON.parse(logs.join('\n'))
    assert.ok(Array.isArray(parsed))
    assert.ok(parsed.length >= 1)
  })

  it('listProjects text output deduplicates owned-domain variants in the count', async () => {
    await client.putProject('proj-owned', {
      displayName: 'Owned',
      canonicalDomain: 'a.com',
      ownedDomains: ['docs.a.com', 'https://www.docs.a.com/path'],
      country: 'US',
      language: 'en',
    })

    const { listProjects } = await import('../src/commands/project.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listProjects()
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    assert.match(output, /proj-owned/)
    assert.match(output, /a\.com \(\+1\)/)
    assert.doesNotMatch(output, /a\.com \(\+2\)/)
  })

  it('showSettings with format json outputs valid JSON', async () => {
    const { showSettings } = await import('../src/commands/settings.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showSettings('json')
    } finally {
      console.log = origLog
    }

    const parsed = JSON.parse(logs.join('\n'))
    assert.ok(parsed.providers)
    assert.ok(Array.isArray(parsed.providers))
  })
})
