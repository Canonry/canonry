import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiKeys, createClient, migrate } from '@ainyc/canonry-db'
import { parse } from 'yaml'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

interface WordpressSiteRequest {
  method: string
  path: string
  body: string
}

/**
 * The WordPress site, as a real server on 127.0.0.1. The server reaches
 * WordPress only through its egress guard, which dials the address it checked
 * and never calls `globalThis.fetch`, and `canonry serve` admits loopback.
 */
async function startWordpressSite(
  respond: (request: WordpressSiteRequest, response: http.ServerResponse) => void,
): Promise<{ url: string; requests: WordpressSiteRequest[]; close: () => Promise<void> }> {
  const requests: WordpressSiteRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const request = { method: req.method ?? '', path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') }
      requests.push(request)
      respond(request, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

function sendJson(response: http.ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
}

function sendNotLoggedIn(response: http.ServerResponse): void {
  response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({
    code: 'rest_not_logged_in',
    message: 'You are not currently logged in.',
    data: { status: 401 },
  }))
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
  let closeHarness: (() => Promise<void>) | null = null
  let closeSite: (() => Promise<void>) | null = null

  beforeEach(() => {
    // Keep the URL safety guard real without resolving external fixture hosts.
    vi.spyOn(dns, 'resolve4').mockImplementation(async (hostname) => (
      hostname === 'example.com' ? ['93.184.216.34'] : []
    ))
    vi.spyOn(dns, 'resolve6').mockResolvedValue([])
  })

  afterEach(async () => {
    const dnsHosts = [...vi.mocked(dns.resolve4).mock.calls, ...vi.mocked(dns.resolve6).mock.calls]
      .map(([hostname]) => hostname)
    vi.restoreAllMocks()
    if (closeHarness) {
      await closeHarness()
      closeHarness = null
    }
    if (closeSite) {
      await closeSite()
      closeSite = null
    }
    if (originalConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = originalConfigDir
    }
    // The resolver catches errors, so unexpected fixture hosts must fail here.
    expect(dnsHosts.filter((hostname) => hostname !== 'example.com')).toEqual([])
  })

  it('errors when wordpress connect omits --app-password', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR

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

    const harness = await startHarness()
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    const site = await startWordpressSite((request, response) => {
      if (request.path.startsWith('/wp-json/wp/v2/users/me?')) return sendNotLoggedIn(response)
      response.writeHead(404).end()
    })
    closeSite = site.close

    const result = await invokeCli([
      'wordpress',
      'connect',
      'test-proj',
      '--url',
      site.url,
      '--user',
      'admin',
      '--app-password',
      'app-pass',
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Authentication failed')
    expect(result.stderr).toContain('application password is incorrect')
    expect(site.requests.map(({ path }) => path)).toEqual(['/wp-json/wp/v2/users/me?_fields=id,slug'])

    const stored = parse(fs.readFileSync(harness.configPath, 'utf-8')) as {
      wordpress?: { connections?: Array<{ projectName: string }> }
    }
    expect(stored.wordpress?.connections ?? []).toHaveLength(0)
  })

  it('routes wordpress pages to the staging environment when --staging is provided', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR

    const staging = await startWordpressSite((request, response) => {
      if (request.path.startsWith('/wp-json/wp/v2/pages?per_page=100&page=1')) {
        return sendJson(response, [
          {
            id: 1,
            slug: 'about',
            status: 'publish',
            link: `${staging.url}/about/`,
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'About' },
          },
        ], { 'x-wp-totalpages': '1' })
      }
      response.writeHead(404).end()
    })
    closeSite = staging.close

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            // Never dialed: the request names the staging environment.
            url: 'https://example.com',
            stagingUrl: staging.url,
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
    expect(staging.requests).toHaveLength(1)
  })

  it('reads create-page content from --content-file', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR

    const site = await startWordpressSite((request, response) => {
      const page = {
        id: 5,
        slug: 'about',
        status: 'draft',
        link: `${site.url}/about/`,
        modified: '2026-03-27T12:00:00Z',
        title: { rendered: 'About' },
        content: { raw: '<p>From file</p>' },
        meta: {},
      }
      if (request.path === '/wp-json/wp/v2/pages' && request.method === 'POST') return sendJson(response, page)
      if (request.path.startsWith('/wp-json/wp/v2/pages?slug=about')) return sendJson(response, [page])
      if (request.path === '/about/') {
        return response.writeHead(200).end('<html><head><title>About</title></head><body>From file</body></html>')
      }
      response.writeHead(404).end('Not found')
    })
    closeSite = site.close

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            url: site.url,
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
    const created = site.requests.find((request) => request.method === 'POST')
    expect(JSON.parse(created!.body)).toEqual({
      title: 'About',
      slug: 'about',
      content: '<p>From file</p>',
      status: 'draft',
    })
  })

  it('returns manual schema instructions instead of applying schema remotely', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR

    const site = await startWordpressSite((request, response) => {
      if (request.path.startsWith('/wp-json/wp/v2/pages?slug=about')) {
        return sendJson(response, [
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
      response.writeHead(404).end()
    })
    closeSite = site.close

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            url: site.url,
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
    // The page's own link, and the admin URL of the connected site.
    expect(body.targetUrl).toBe('https://example.com/about/')
    expect(body.adminUrl).toBe(`${site.url}/wp-admin/`)
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

    const site = await startWordpressSite((request, response) => {
      if (request.path.startsWith('/wp-json/wp/v2/pages?per_page=100&page=1')) {
        return sendJson(response, [], { 'x-wp-total': '0', 'x-wp-totalpages': '1' })
      }
      response.writeHead(404).end()
    })
    closeSite = site.close

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            url: site.url,
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

    const result = await invokeCli([
      'wordpress', 'schema', 'status', 'test-proj', '--format', 'json',
    ])

    const body = parseJsonOutput(result.stdout) as { env: string; pages: unknown[] }
    expect(body.env).toBe('live')
    expect(body.pages).toEqual([])
  })

  it('onboard returns a failed connect step when WordPress credentials are invalid', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR

    const harness = await startHarness()
    closeHarness = harness.close
    process.env.CANONRY_CONFIG_DIR = harness.tmpDir

    const site = await startWordpressSite((request, response) => {
      if (request.path.startsWith('/wp-json/wp/v2/users/me?')) return sendNotLoggedIn(response)
      response.writeHead(404).end()
    })
    closeSite = site.close

    const result = await invokeCli([
      'wordpress', 'onboard', 'test-proj',
      '--url', site.url,
      '--user', 'admin',
      '--app-password', 'wrong-pass',
      '--skip-schema',
      '--skip-submit',
      '--format', 'json',
    ])

    const body = parseJsonOutput(result.stdout) as { steps: Array<{ name: string; status: string; error?: string }> }
    expect(body.steps[0]).toMatchObject({ name: 'connect', status: 'failed' })
    expect(body.steps[0]!.error).toContain('Authentication failed')
  })

  it('renders actionable errors when SEO meta writes are unsupported', async () => {
    originalConfigDir = process.env.CANONRY_CONFIG_DIR

    const site = await startWordpressSite((request, response) => {
      if (request.path.startsWith('/wp-json/wp/v2/pages?slug=about')) {
        return sendJson(response, [
          {
            id: 5,
            slug: 'about',
            status: 'publish',
            link: `${site.url}/about/`,
            modified: '2026-03-27T12:00:00Z',
            title: { rendered: 'About' },
            content: { raw: '<p>About</p>' },
            meta: {},
          },
        ])
      }
      response.writeHead(404).end('Not found')
    })
    closeSite = site.close

    const now = new Date().toISOString()
    const harness = await startHarness({
      wordpress: {
        connections: [
          {
            projectName: 'test-proj',
            url: site.url,
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
