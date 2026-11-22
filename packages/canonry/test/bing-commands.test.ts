import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys } from '@canonry/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli } from './cli-test-utils.js'

describe('bing CLI commands', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let serverUrl: string
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-bing-cmd-test-${crypto.randomUUID()}`)
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
      bing: { apiKey: 'saved-bing-key' },
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
    serverUrl = `http://127.0.0.1:${port}`

    config.apiUrl = serverUrl
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    close = () => app.close()
    client = new ApiClient(serverUrl, apiKeyPlain)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await close()
    if (origConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = origConfigDir
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('connects with the Settings key and retains the selected site without exposing the key', async () => {
    const project = 'test-proj'
    const url = 'https://example.com/'
    await client.putProject(project, { displayName: 'Test', canonicalDomain: 'example.com', country: 'US', language: 'en' })
    const bing = await import('@canonry/canonry-integration-bing')
    const sites = vi.spyOn(bing, 'getSites').mockResolvedValue([{ Url: url, IsVerified: true }])
    sites.mockRejectedValueOnce(new Error('Bing rejected saved-bing-key'))
    const refused = await invokeCli(['bing', 'connect', project, '--use-saved-key', '--format', 'json'])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('Canonry Settings')
    expect(refused.stderr).not.toContain('saved-bing-key')

    const result = await invokeCli(['bing', 'connect', project, '--use-saved-key', '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toEqual({
      connected: true, domain: 'example.com', siteUrl: null, availableSites: [{ url, verified: true }],
    })
    expect(sites).toHaveBeenCalledWith('saved-bing-key')
    await client.bingSetSite(project, url)
    expect(await client.bingStatus(project)).toMatchObject({ connected: true, siteUrl: url })
    expect(await client.bingSites(project)).toEqual({ sites: [{ url, verified: true }] })
  })

  it('lets a project writer select its own Bing site while protecting other sites and shared connections', async () => {
    const settings = { displayName: 'Project', canonicalDomain: 'example.com', country: 'US', language: 'en' }
    const project = await client.putProject('scoped', settings)
    const key = await client.createApiKey({ name: 'project-writer', projectId: project.id, scopes: ['*'] })
    const scoped = new ApiClient(serverUrl, key.key)
    const bing = await import('@canonry/canonry-integration-bing')
    vi.spyOn(bing, 'getSites').mockResolvedValue([{ Url: 'https://www.example.com/', IsVerified: true }])
    await scoped.bingConnect(project.name, { apiKey: 'project-owned-key' })
    await scoped.bingSetSite(project.name, 'https://www.example.com/')
    await expect(scoped.bingSetSite(project.name, 'https://another.example/')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await client.putProject('shared', settings)
    await expect(scoped.bingSetSite(project.name, 'https://example.com/')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await client.bingStatus(project.name)).toMatchObject({ siteUrl: 'https://www.example.com/' })
  })

  it('bingRefresh prints "No previously inspected URLs" when project has no inspections', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { bingRefresh } = await import('../src/commands/bing.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await bingRefresh('test-proj')
    } finally {
      console.log = origLog
    }

    expect(logs.join('\n')).toMatch(/No previously inspected URLs/)
  })

  it('bingRefresh outputs JSON when format is json and no inspections exist', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { bingRefresh } = await import('../src/commands/bing.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await bingRefresh('test-proj', 'json')
    } finally {
      console.log = origLog
    }

    const parsed = JSON.parse(logs.join('\n')) as { refreshed: number; message: string }
    expect(parsed.refreshed).toBe(0)
    expect(parsed.message).toMatch(/No previously inspected URLs/)
  })

  it('bingRefresh handles no inspections gracefully in text mode', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { bingRefresh } = await import('../src/commands/bing.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await bingRefresh('test-proj')
    } finally {
      console.log = origLog
    }

    const output = logs.join('\n')
    expect(output).toMatch(/No previously inspected URLs/)
    expect(output).toMatch(/canonry bing inspect/)
  })
})
