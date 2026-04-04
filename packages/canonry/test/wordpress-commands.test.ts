import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiKeys, createClient, migrate } from '@ainyc/canonry-db'
import { parse } from 'yaml'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })
}

async function startHarness(opts?: {
  wordpress?: {
    connections?: Array<{
      projectName: string
      url: string
      stagingUrl?: string
      username: string
      appPassword: string
      defaultEnv: 'live' | 'staging'
      createdAt: string
      updatedAt: string
    }>
  }
}) {
  const tmpDir = path.join(os.tmpdir(), `canonry-wordpress-cmd-test-${crypto.randomUUID()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

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
    ...(opts?.wordpress ? { wordpress: opts.wordpress } : {}),
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

  const client = new ApiClient(serverUrl, apiKeyPlain)
  await client.putProject('test-proj', {
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
  })

  return {
    tmpDir,
    configPath,
    app,
    client,
    serverUrl,
    close: async () => {
      await app.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

describe('wordpress CLI commands', () => {
  let originalConfigDir: string | undefined
  let originalFetch: typeof globalThis.fetch
  let closeHarness: (() => Promise<void>) | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
    if (closeHarness) {
      await closeHarness()
      closeHarness = null
    }
    if (originalConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = originalConfigDir
    }
  })

  it('errors when wordpress connect omits --app-password', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    originalFetch = globalThis.fetch

    const harness = await startHarness()
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    const result = await invokeCli([
      'wordpress',
      'connect',
      'test-proj',
      '--url',
      'https://example.com',
      '--user',
      'admin',
      '--format',
      'json',
    ])

    expect(result.exitCode).toBe(1)
    const error = parseJsonOutput(result.stderr) as { error: { code: string; message: string } }
    expect(error.error.code).toBe('WORDPRESS_APP_PASSWORD_REQUIRED')
    expect(error.error.message).toContain('Application Password is required')
  })

  it('shows an actionable error when wordpress connect fails with invalid credentials', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    originalFetch = globalThis.fetch

    const harness = await startHarness()
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(harness.serverUrl)) {
        return originalFetch(input, init)
      }
      if (url.includes('/wp-json/wp/v2/users/me?')) {
        return new Response(
          JSON.stringify({
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 },
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json',
            },
          },
        )
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const result = await invokeCli([
      'wordpress',
      'connect',
      'test-proj',
      '--url',
      'https://example.com',
      '--user',
      'admin',
      '--app-password',
      'app-pass',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Authentication failed')
    expect(result.stderr).toContain('application password is incorrect')

    const stored = parse(fs.readFileSync(harness.configPath, 'utf-8')) as {
      wordpress?: { connections?: Array<{ projectName: string }> }
    }
    expect(stored.wordpress?.connections ?? []).toHaveLength(0)
  })

  it('routes wordpress pages to the staging environment when --staging is provided', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    originalFetch = globalThis.fetch

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            url: 'https://example.com',
            stagingUrl: 'https://staging.example.com',
            username: 'admin',
            appPassword: 'app-pass',
            defaultEnv: 'live',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    })
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(harness.serverUrl)) {
        return originalFetch(input, init)
      }
      if (url.includes('https://staging.example.com/wp-json/wp/v2/pages?per_page=100&page=1')) {
        return jsonResponse([
          {
            id: 1,
            slug: 'about',
            status: 'publish',
            link: 'https://staging.example.com/about/',
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'About' },
          },
        ], {
          headers: {
            'x-wp-totalpages': '1',
          },
        })
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const result = await invokeCli([
      'wordpress',
      'pages',
      'test-proj',
      '--staging',
      '--format',
      'json',
    ])

    const body = parseJsonOutput(result.stdout) as {
      env: string
      pages: Array<{ slug: string; title: string; status: string }>
    }
    expect(body).toMatchObject({
      env: 'staging',
      pages: [{ slug: 'about', title: 'About', status: 'publish' }],
    })
  })

  it('reads create-page content from --content-file', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    originalFetch = globalThis.fetch

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            url: 'https://example.com',
            username: 'admin',
            appPassword: 'app-pass',
            defaultEnv: 'live',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    })
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    const contentPath = path.join(harness.tmpDir, 'page.html')
    fs.writeFileSync(contentPath, '<p>From file</p>', 'utf-8')

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(harness.serverUrl)) {
        return originalFetch(input, init)
      }
      if (url.includes('/wp-json/wp/v2/pages') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { title: string; slug: string; content: string; status: string }
        expect(body).toMatchObject({
          title: 'About',
          slug: 'about',
          content: '<p>From file</p>',
          status: 'draft',
        })
        return jsonResponse({
          id: 5,
          slug: 'about',
          status: 'draft',
          link: 'https://example.com/about/',
          modified: '2026-03-27T12:00:00Z',
          title: { rendered: 'About' },
          content: { raw: '<p>From file</p>' },
          meta: {},
        })
      }
      if (url.includes('/wp-json/wp/v2/plugins')) {
        return new Response('Not found', { status: 404 })
      }
      if (url.includes('/wp-json/wp/v2/pages?slug=about')) {
        return jsonResponse([
          {
            id: 5,
            slug: 'about',
            status: 'draft',
            link: 'https://example.com/about/',
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'About' },
            content: { raw: '<p>From file</p>' },
            meta: {},
          },
        ])
      }
      if (url === 'https://example.com/about/') {
        return new Response('<html><head><title>About</title></head><body>From file</body></html>', { status: 200 })
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const result = await invokeCli([
      'wordpress',
      'create-page',
      'test-proj',
      '--title',
      'About',
      '--slug',
      'about',
      '--content-file',
      contentPath,
      '--format',
      'json',
    ])

    const body = parseJsonOutput(result.stdout) as { slug: string; content: string }
    expect(body.slug).toBe('about')
    expect(body.content).toBe('<p>From file</p>')
  })

  it('returns manual schema instructions instead of applying schema remotely', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    originalFetch = globalThis.fetch

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            url: 'https://example.com',
            username: 'admin',
            appPassword: 'app-pass',
            defaultEnv: 'live',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    })
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(harness.serverUrl)) {
        return originalFetch(input, init)
      }
      if (url.includes('/wp-json/wp/v2/pages?slug=about')) {
        return jsonResponse([
          {
            id: 5,
            slug: 'about',
            status: 'publish',
            link: 'https://example.com/about/',
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'About' },
            content: { raw: '<p>About</p>' },
            meta: {},
          },
        ])
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const result = await invokeCli([
      'wordpress',
      'set-schema',
      'test-proj',
      'about',
      '--type',
      'FAQPage',
      '--json',
      '{"@type":"FAQPage"}',
      '--format',
      'json',
    ])

    const body = parseJsonOutput(result.stdout) as {
      manualRequired: boolean
      targetUrl: string
      adminUrl: string
      content: string
    }
    expect(body.manualRequired).toBe(true)
    expect(body.targetUrl).toBe('https://example.com/about/')
    expect(body.adminUrl).toBe('https://example.com/wp-admin/')
    expect(body.content).toBe('{"@type":"FAQPage"}')
  })

  it('bulk set-meta reports an error when the --from file does not exist', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR

    const harness = await startHarness()
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    const result = await invokeCli([
      'wordpress', 'set-meta', 'test-proj', '--from', '/does/not/exist.json',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('cannot read file')
  })

  it('bulk set-meta reports an error when the --from file is not valid JSON', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR

    const harness = await startHarness()
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    const metaFile = path.join(harness.tmpDir, 'meta.json')
    fs.writeFileSync(metaFile, 'not json', 'utf-8')

    const result = await invokeCli([
      'wordpress', 'set-meta', 'test-proj', '--from', metaFile,
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('not valid JSON')
  })

  it('schema deploy reports an error when the --profile file does not exist', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR

    const harness = await startHarness()
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    const result = await invokeCli([
      'wordpress', 'schema', 'deploy', 'test-proj', '--profile', '/does/not/exist.yaml',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('cannot read file')
  })

  it('schema status outputs JSON with empty pages when no pages are published', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    originalFetch = globalThis.fetch

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            url: 'https://example.com',
            username: 'admin',
            appPassword: 'app-pass',
            defaultEnv: 'live',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    })
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(harness.serverUrl)) {
        return originalFetch(input, init)
      }
      if (url.includes('/wp-json/wp/v2/pages?per_page=100&page=1')) {
        return jsonResponse([], {
          headers: {
            'x-wp-total': '0',
            'x-wp-totalpages': '1',
          },
        })
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const result = await invokeCli([
      'wordpress', 'schema', 'status', 'test-proj', '--format', 'json',
    ])

    const body = parseJsonOutput(result.stdout) as { env: string; pages: unknown[] }
    expect(body.env).toBe('live')
    expect(body.pages).toEqual([])
  })

  it('onboard returns a failed connect step when WordPress credentials are invalid', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    originalFetch = globalThis.fetch

    const harness = await startHarness()
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(harness.serverUrl)) {
        return originalFetch(input, init)
      }
      if (url.includes('/wp-json/wp/v2/users/me?')) {
        return new Response(
          JSON.stringify({
            code: 'rest_not_logged_in',
            message: 'You are not currently logged in.',
            data: { status: 401 },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const result = await invokeCli([
      'wordpress', 'onboard', 'test-proj',
      '--url', 'https://example.com',
      '--user', 'admin',
      '--app-password', 'wrong-pass',
      '--skip-schema',
      '--skip-submit',
      '--format', 'json',
    ])

    const body = parseJsonOutput(result.stdout) as { steps: Array<{ name: string; status: string }> }
    expect(body.steps[0]).toMatchObject({ name: 'connect', status: 'failed' })
  })

  it('renders actionable errors when SEO meta writes are unsupported', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    originalFetch = globalThis.fetch

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            url: 'https://example.com',
            username: 'admin',
            appPassword: 'app-pass',
            defaultEnv: 'live',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    })
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(harness.serverUrl)) {
        return originalFetch(input, init)
      }
      if (url.includes('/wp-json/wp/v2/plugins')) {
        return new Response('Not found', { status: 404 })
      }
      if (url.includes('/wp-json/wp/v2/pages?slug=about')) {
        return jsonResponse([
          {
            id: 5,
            slug: 'about',
            status: 'publish',
            link: 'https://example.com/about/',
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'About' },
            content: { raw: '<p>About</p>' },
            meta: {},
          },
        ])
      }
      throw new Error(`Unhandled URL: ${url}`)
    }

    const result = await invokeCli([
      'wordpress',
      'set-meta',
      'test-proj',
      'about',
      '--title',
      'New SEO Title',
      '--format',
      'json',
    ])

    expect(result.exitCode).toBe(1)
    const error = parseJsonOutput(result.stderr) as { error: { message: string } }
    expect(error.error.message).toContain('does not expose writable SEO meta fields')
  })
})
