import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'

describe('location CLI commands', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-location-cmd-test-${crypto.randomUUID()}`)
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

    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: {},
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

  it('project add-location adds a location and prints confirmation', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { addLocation } = await import('../src/commands/project.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await addLocation('test-proj', { label: 'nyc', city: 'New York', region: 'NY', country: 'US' })
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/nyc/)
    expect(output).toMatch(/New York/)
  })

  it('project locations lists configured locations', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
    await client.addLocation('test-proj', { label: 'nyc', city: 'New York', region: 'NY', country: 'US' })

    const { listLocations } = await import('../src/commands/project.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listLocations('test-proj')
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/nyc/)
    expect(output).toMatch(/New York/)
  })

  it('project locations prints "No locations configured" when empty', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { listLocations } = await import('../src/commands/project.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await listLocations('test-proj')
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/No locations configured/)
  })

  it('project remove-location removes a location and prints confirmation', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
    await client.addLocation('test-proj', { label: 'nyc', city: 'New York', region: 'NY', country: 'US' })

    const { removeLocation } = await import('../src/commands/project.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await removeLocation('test-proj', 'nyc')
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/nyc/)

    // Verify it was actually removed
    const result = await client.listLocations('test-proj')
    expect(result.locations).toHaveLength(0)
  })

  it('project set-default-location sets the default location', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
    await client.addLocation('test-proj', { label: 'nyc', city: 'New York', region: 'NY', country: 'US' })
    await client.addLocation('test-proj', { label: 'lax', city: 'Los Angeles', region: 'CA', country: 'US' })

    const { setDefaultLocation } = await import('../src/commands/project.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await setDefaultLocation('test-proj', 'nyc')
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/nyc/)

    // Verify default was actually set
    const result = await client.listLocations('test-proj')
    expect(result.defaultLocation).toBe('nyc')
  })

  it('run --all-locations triggers one run per configured location', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
    await client.addLocation('test-proj', { label: 'nyc', city: 'New York', region: 'NY', country: 'US' })
    await client.addLocation('test-proj', { label: 'lax', city: 'Los Angeles', region: 'CA', country: 'US' })

    const { triggerRun } = await import('../src/commands/run.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await triggerRun('test-proj', { allLocations: true })
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    // Should show 2 location sweeps with multiplier in the output
    expect(output).toMatch(/2 location sweep/)
    expect(output).toMatch(/nyc/)
    expect(output).toMatch(/lax/)
  })

  it('run --all-locations output includes API call multiplier', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
    await client.addLocation('test-proj', { label: 'nyc', city: 'New York', region: 'NY', country: 'US' })
    await client.addLocation('test-proj', { label: 'lax', city: 'Los Angeles', region: 'CA', country: 'US' })
    await client.addLocation('test-proj', { label: 'chi', city: 'Chicago', region: 'IL', country: 'US' })

    const { triggerRun } = await import('../src/commands/run.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await triggerRun('test-proj', { allLocations: true })
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/3 location sweep/)
    expect(output).toMatch(/3× API calls/)
  })

  it('run --all-locations with format json outputs an array', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
    await client.addLocation('test-proj', { label: 'nyc', city: 'New York', region: 'NY', country: 'US' })
    await client.addLocation('test-proj', { label: 'lax', city: 'Los Angeles', region: 'CA', country: 'US' })

    const { triggerRun } = await import('../src/commands/run.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await triggerRun('test-proj', { allLocations: true, format: 'json' })
    } finally {
      console.log = origLog
    }

    // Find the JSON line (may have background [Notifier] logs mixed in)
    const jsonLine = logs.find(l => {
      try { JSON.parse(l); return true } catch { return false }
    })
    expect(jsonLine, 'should have a JSON log line').toBeDefined()
    const parsed = JSON.parse(jsonLine) as Array<{ id: string; location: string; status: string }>
    expect(parsed, 'response should be an array').toBeInstanceOf(Array)
    expect(parsed).toHaveLength(2)
    const labels = parsed.map(r => r.location).sort()
    expect(labels).toEqual(['lax', 'nyc'])
    // Each run should have a valid id and status
    for (const r of parsed) {
      expect(r.id, 'each run should have an id').toBeDefined()
      expect(r.status, 'each run should have a status').toBeDefined()
    }
  })

  it('run --all-locations returns an error when no locations configured', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { triggerRun } = await import('../src/commands/run.js')
    await expect(() => triggerRun('test-proj', { allLocations: true })).rejects.toThrow(/No locations configured/)
  })
})
