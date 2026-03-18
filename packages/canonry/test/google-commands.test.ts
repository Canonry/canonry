import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'

describe('google CLI commands', () => {
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

    expect(logs.join('\n')).toMatch(/No URL inspections found/)
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
    expect('summary' in parsed, 'JSON output should contain a summary field').toBeTruthy()
    expect(parsed.summary.total).toBe(0)
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
    expect(output).toMatch(/Sitemap inspection started/)
  })

  it('googleSetSitemap prints confirmation after saving sitemap URL', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { googleSetSitemap } = await import('../src/commands/google.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await googleSetSitemap('test-proj', 'https://example.com/sitemap.xml')
    } finally {
      console.log = origLog
    }

    expect(logs.join('\n')).toMatch(/GSC sitemap URL set to/)
    expect(logs.join('\n')).toMatch(/https:\/\/example\.com\/sitemap\.xml/)
  })

  it('googleListSitemaps rejects when the GSC access token is rejected by Google', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { googleListSitemaps } = await import('../src/commands/google.js')
    // The fake access token causes Google to return 401, which gscFetch propagates as
    // a GoogleApiError(401) → Fastify returns HTTP 401 → ApiClient throws
    await expect(() => googleListSitemaps('test-proj', {})).rejects.toThrow('Access token expired or revoked')
  })

  it('googleDiscoverSitemaps rejects when the GSC access token is rejected by Google', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { googleDiscoverSitemaps } = await import('../src/commands/google.js')
    // The fake access token causes Google to return 401, which gscFetch propagates as
    // a GoogleApiError(401) → Fastify returns HTTP 401 → ApiClient throws
    await expect(() => googleDiscoverSitemaps('test-proj', { wait: false })).rejects.toThrow('Access token expired or revoked')
  })

  it('googleRequestIndexing prints success output for a single URL', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Only intercept Google Indexing API calls
      if (url.includes('indexing.googleapis.com')) {
        return new Response(JSON.stringify({
          urlNotificationMetadata: {
            url: 'https://example.com/page',
            latestUpdate: {
              url: 'https://example.com/page',
              type: 'URL_UPDATED',
              notifyTime: '2026-03-17T12:00:00Z',
            },
          },
        }), { status: 200 })
      }
      return originalFetch(input, init)
    }

    const { googleRequestIndexing } = await import('../src/commands/google.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await googleRequestIndexing('test-proj', { url: 'https://example.com/page' })
    } finally {
      console.log = origLog
      globalThis.fetch = originalFetch
    }

    const output = logs.join('\n')
    expect(output).toMatch(/Indexing requested: https:\/\/example\.com\/page/)
    expect(output).toMatch(/Notified at:/)
    expect(output).toMatch(/Type: URL_UPDATED/)
  })

  it('googleRequestIndexing outputs JSON when format is json', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('indexing.googleapis.com')) {
        return new Response(JSON.stringify({
          urlNotificationMetadata: {
            url: 'https://example.com/page',
            latestUpdate: {
              url: 'https://example.com/page',
              type: 'URL_UPDATED',
              notifyTime: '2026-03-17T12:00:00Z',
            },
          },
        }), { status: 200 })
      }
      return originalFetch(input, init)
    }

    const { googleRequestIndexing } = await import('../src/commands/google.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await googleRequestIndexing('test-proj', { url: 'https://example.com/page', format: 'json' })
    } finally {
      console.log = origLog
      globalThis.fetch = originalFetch
    }

    const parsed = JSON.parse(logs.join('\n')) as { summary: { total: number; succeeded: number }; results: Array<{ status: string }> }
    expect(parsed.summary.total).toBe(1)
    expect(parsed.summary.succeeded).toBe(1)
    expect(parsed.results[0]!.status).toBe('success')
  })

  it('googleRequestIndexing exits with error when neither URL nor --all-unindexed is provided', async () => {
    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const { googleRequestIndexing } = await import('../src/commands/google.js')
    const errors: string[] = []
    const origError = console.error
    const origExit = process.exit
    console.error = (...args: unknown[]) => errors.push(args.join(' '))
    process.exit = (() => { throw new Error('process.exit called') }) as never
    try {
      await googleRequestIndexing('test-proj', {})
    } catch (err) {
      expect((err as Error).message).toBe('process.exit called')
    } finally {
      console.error = origError
      process.exit = origExit
    }

    expect(errors.join('\n')).toMatch(/provide a URL or use --all-unindexed/)
  })
})
