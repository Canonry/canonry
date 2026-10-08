import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DoctorReportDto } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import type { WordpressConnectionRecord } from '@ainyc/canonry-integration-wordpress'
import { apiRoutes } from '../src/index.js'
import type { WordpressTrafficCredentialRecord } from '../src/traffic.js'
import { startRecordingSite, type RecordedRequest, type RecordingSite } from './recording-site-fixture.js'

/**
 * Every WordPress path that dials the operator's site sends each request and
 * each redirect hop through the egress guard: the publishing routes and their
 * doctor check, and the traffic connect probe, sync and doctor probe.
 *
 * The app admits loopback, as local `canonry serve` does, so the fixture site
 * can stand on 127.0.0.1 under the name `wp.test`. `0.0.0.0` reaches the same
 * socket but stays refused, so a redirect there that was followed shows up as
 * a served `/internal` request.
 */

const SITE_HOST = 'wp.test'
const INTERNAL_PATH = '/internal'

type Respond = (request: RecordedRequest, response: http.ServerResponse, port: number) => void

let site: RecordingSite
let respond: Respond
/** The address `wp.test` resolves to; null when the name has no address. */
let siteAddress: string | null
let cleanup: Array<() => Promise<void> | void> = []

function redirectInternal(response: http.ServerResponse, port: number): void {
  response.writeHead(302, { Location: `http://0.0.0.0:${port}${INTERNAL_PATH}` }).end()
}

function json(response: http.ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(200, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body))
}

function servedPaths(): string[] {
  return site.requests.map(({ path: requestPath }) => requestPath.split('?')[0]!)
}

async function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpress-egress-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: crypto.randomUUID(),
    name: 'test-project',
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  const siteUrl = `http://${SITE_HOST}:${site.port}`
  const publishing: WordpressConnectionRecord = {
    projectName: 'test-project',
    url: siteUrl,
    username: 'admin',
    appPassword: 'app-pass',
    defaultEnv: 'live',
    createdAt: now,
    updatedAt: now,
  }
  const trafficCredentials = new Map<string, WordpressTrafficCredentialRecord>()

  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    allowLoopbackWebhooks: true,
    wordpressConnectionStore: {
      getConnection: (projectName) => (projectName === 'test-project' ? publishing : undefined),
      upsertConnection: (connection) => connection,
      updateConnection: () => publishing,
      deleteConnection: () => false,
    },
    wordpressTrafficCredentialStore: {
      getConnection: (projectName) => trafficCredentials.get(projectName),
      upsertConnection: (record) => {
        trafficCredentials.set(record.projectName, record)
        return record
      },
      deleteConnection: (projectName) => trafficCredentials.delete(projectName),
    },
  })
  await app.ready()
  cleanup.push(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  return { app, siteUrl }
}

beforeEach(async () => {
  site = await startRecordingSite((request, response, port) => respond(request, response, port))
  cleanup.push(() => site.close())
  respond = (_request, response) => response.writeHead(404).end()
  siteAddress = '127.0.0.1'
  // The real egress policy resolves the site's name; only that name is answered.
  vi.spyOn(dns, 'resolve4').mockImplementation(async (hostname) => (hostname === SITE_HOST && siteAddress ? [siteAddress] : []))
  vi.spyOn(dns, 'resolve6').mockResolvedValue([])
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const step of cleanup.reverse()) await step()
  cleanup = []
})

describe('WordPress publishing routes', () => {
  it('refuses a REST call the site redirects to an internal address before the credentials follow it', async () => {
    const { app } = await buildApp()
    respond = (request, response, port) => {
      if (request.path.startsWith('/wp-json/wp/v2/pages')) return redirectInternal(response, port)
      response.writeHead(200).end('internal')
    }

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/wordpress/pages' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: `Refused to connect to 0.0.0.0:${site.port}: must not resolve to a private or loopback address`,
      },
    })
    expect(servedPaths()).toEqual(['/wp-json/wp/v2/pages'])
  })

  it('checks the stored URL again on every call, so a DNS change after connect is refused', async () => {
    const { app } = await buildApp()
    respond = (_request, response) => json(response, [], { 'x-wp-totalpages': '1' })

    const first = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/wordpress/pages' })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ env: 'live', pages: [] })

    siteAddress = '10.0.0.5'
    const second = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/wordpress/pages' })

    expect(second.statusCode).toBe(400)
    expect(second.json().error.message)
      .toBe(`Refused to connect to ${SITE_HOST}:${site.port}: must not resolve to a private or loopback address`)
    expect(servedPaths()).toEqual(['/wp-json/wp/v2/pages'])
  })

  it('answers a stored site whose name stops resolving as an upstream failure, not a refusal', async () => {
    const { app } = await buildApp()
    siteAddress = null

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/wordpress/pages' })

    // A DNS outage is retryable; VALIDATION_ERROR would tell the caller its input was wrong.
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: { code: 'PROVIDER_ERROR', message: `Could not resolve ${SITE_HOST}` } })
    expect(servedPaths()).toEqual([])
  })

  it('never fetches a rendered page link that points at an internal address', async () => {
    const { app } = await buildApp()
    respond = (request, response, port) => {
      if (request.path.startsWith('/wp-json/wp/v2/plugins')) return json(response, [])
      if (request.path.startsWith('/wp-json/wp/v2/pages')) {
        return json(response, [{
          id: 7,
          slug: 'about',
          status: 'publish',
          link: `http://0.0.0.0:${port}${INTERNAL_PATH}`,
          title: { rendered: 'About' },
          content: { raw: 'About us' },
        }])
      }
      response.writeHead(200).end('<title>Internal admin</title>')
    }

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/wordpress/page?slug=about' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      slug: 'about',
      seo: { title: null, description: null, noindex: null },
      schemaBlocks: [],
    })
    expect(servedPaths()).toEqual(['/wp-json/wp/v2/plugins', '/wp-json/wp/v2/pages'])
  })

  it('does not return an internal body that llms.txt redirects to', async () => {
    const { app, siteUrl } = await buildApp()
    respond = (request, response, port) => {
      if (request.path === '/llms.txt') return redirectInternal(response, port)
      response.writeHead(200).end('internal secret')
    }

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/wordpress/llms-txt' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ env: 'live', url: `${siteUrl}/llms.txt`, content: null })
    expect(servedPaths()).toEqual(['/llms.txt'])
  })

  it('guards the publishing doctor check the same way', async () => {
    const { app } = await buildApp()
    respond = (request, response, port) => {
      if (request.path.startsWith('/wp-json/wp/v2/users/me')) return redirectInternal(response, port)
      response.writeHead(200).end('{"id":1,"slug":"root"}')
    }

    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/doctor?check=wordpress.publish.connection' })

    const check = (res.json() as DoctorReportDto).checks.find((c) => c.id === 'wordpress.publish.connection')
    expect(check).toMatchObject({
      status: 'fail',
      code: 'wordpress.publish.verification-failed',
      details: { error: `Refused to connect to 0.0.0.0:${site.port}: must not resolve to a private or loopback address` },
    })
    expect(servedPaths()).toEqual(['/wp-json/wp/v2/users/me'])
  })
})

describe('WordPress traffic pulls', () => {
  const connectBody = (siteUrl: string) => ({ baseUrl: siteUrl, username: 'canonry-bot', applicationPassword: 'xxxx xxxx' })
  const emptyPage = { events: [], next_cursor: null, has_more: false }

  it('refuses a connect probe the site redirects to an internal IP literal', async () => {
    const { app, siteUrl } = await buildApp()
    respond = (request, response, port) => {
      if (request.path.startsWith('/wp-json/canonry/v1/events')) return redirectInternal(response, port)
      json(response, emptyPage)
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: connectBody(siteUrl),
    })

    expect(res.statusCode).toBe(502)
    expect(res.json().error.message)
      .toBe(`WordPress traffic probe failed: Refused to connect to 0.0.0.0:${site.port}: must not resolve to a private or loopback address`)
    expect(servedPaths()).toEqual(['/wp-json/canonry/v1/events'])
  })

  it('refuses the redirect on a later sync and doctor probe of a connected source', async () => {
    const { app, siteUrl } = await buildApp()
    respond = (_request, response) => json(response, emptyPage)
    const connect = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/test-project/traffic/connect/wordpress',
      payload: connectBody(siteUrl),
    })
    expect(connect.statusCode).toBe(200)
    const sourceId = connect.json().id as string

    respond = (request, response, port) => {
      if (request.path.startsWith('/wp-json/canonry/v1/events')) return redirectInternal(response, port)
      json(response, emptyPage)
    }
    const sync = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/test-project/traffic/sources/${sourceId}/sync`,
      payload: {},
    })
    const doctor = await app.inject({ method: 'GET', url: '/api/v1/projects/test-project/doctor?check=traffic.source.credentials' })

    const refusal = `Refused to connect to 0.0.0.0:${site.port}: must not resolve to a private or loopback address`
    expect(sync.statusCode).toBe(502)
    expect(sync.json().error.message).toBe(`WordPress pull failed: ${refusal}`)
    expect((doctor.json() as DoctorReportDto).checks.find((c) => c.id === 'traffic.source.credentials')).toMatchObject({
      status: 'fail',
      code: 'traffic.credentials.failed',
      summary: `1 of 1 source(s) failed credentials validation: WordPress · ${SITE_HOST}:${site.port} (WordPress endpoint probe failed: ${refusal}.).`,
    })
    expect(servedPaths()).toEqual(Array(3).fill('/wp-json/canonry/v1/events'))
  })
})
