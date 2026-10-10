import fs from 'node:fs'
import dns from 'node:dns/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createClient, migrate, projects, runs } from '@ainyc/canonry-db'
import { registerRequestContext } from '@ainyc/canonry-api-routes/request-context'
import { GoogleApiError, GoogleAuthError } from '@ainyc/canonry-integration-google'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent,
}))

const { handleRouteOutcome, outcomeAttribution, outcomeTriggerFor } = await import('../src/outcome-telemetry.js')
const { ApiClient } = await import('../src/client.js')
const { createApiUsageTelemetry } = await import('../src/usage-telemetry.js')
const { googleRunFailure, reportUnstartedRun, runFailure, startRunOutcome, withOutcomeReason } = await import('../src/sync-outcome.js')
const { fetchAndParseSitemap } = await import('../src/sitemap-parser.js')

const NOW = '2026-10-09T12:00:00.000Z'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-sync-outcome-test-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'proj_1', name: 'harborline', displayName: 'Harborline', canonicalDomain: 'harborline.example.com',
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values([
    { id: 'run_manual', projectId: 'proj_1', kind: 'gsc-sync', status: 'queued', trigger: 'manual', createdAt: NOW },
    { id: 'run_scheduled', projectId: 'proj_1', kind: 'inspect-sitemap', status: 'queued', trigger: 'scheduled', createdAt: NOW },
  ]).run()
  return db
}

/** Start a run outcome inside a real request, the way a route's sync callback does, and report it after the response. */
async function reportFromRequest(
  db: ReturnType<typeof createTempDb>,
  runId: string,
  headers: Record<string, string>,
): Promise<void> {
  const app = Fastify()
  registerRequestContext(app)
  let report: ReturnType<typeof startRunOutcome> | undefined
  app.post('/sync', async () => {
    report = startRunOutcome(db, runId, 'search_console', 'sync')
    return { queued: true }
  })
  await app.inject({ method: 'POST', url: '/sync', headers })
  await app.close()
  report!({ status: 'succeeded', counts: { rows: 4 } })
}

beforeEach(() => trackEvent.mockReset())

describe('outcome trigger and attribution', () => {
  it('derives the trigger from who asked: the scheduler, an agent surface, or a person', () => {
    expect(outcomeTriggerFor({ userAgent: 'canonry-cli/7.19.0', surfaceLabel: 'system', agentLabel: 'claude' })).toBe('scheduled')
    expect(outcomeTriggerFor({ userAgent: 'canonry-mcp', surfaceLabel: 'mcp-stdio' })).toBe('agent')
    expect(outcomeTriggerFor({ userAgent: 'canonry-mcp/7.19.0' })).toBe('agent')
    expect(outcomeTriggerFor({ userAgent: 'curl/8', surfaceLabel: 'aero' })).toBe('agent')
    expect(outcomeTriggerFor({ userAgent: 'canonry-cli/7.19.0', surfaceLabel: 'cli' })).toBe('manual')
    expect(outcomeTriggerFor({ userAgent: 'Mozilla/5.0' })).toBe('manual')
    expect(outcomeTriggerFor({ userAgent: 'curl/8' })).toBe('manual')
  })

  it('reports the scheduler client as the server acting alone, without the agent that launched the server', () => {
    expect(outcomeAttribution({ userAgent: 'canonry-cli/7.19.0', surfaceLabel: 'system', agentLabel: 'claude' })).toEqual({ surface: 'system' })
    expect(outcomeAttribution({ userAgent: 'canonry-cli/7.19.0', surfaceLabel: 'cli', agentLabel: 'claude' })).toEqual({ surface: 'cli', agent: 'claude' })
  })

  it('labels the scheduler client system, and usage telemetry still skips its requests', async () => {
    const requests: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
    }))
    try {
      await new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true, surface: 'system' }).listProjects()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(requests.map((request) => [request.headers.get('x-canonry-surface'), request.headers.get('user-agent')?.startsWith('canonry-cli/')]))
      .toEqual([['system', true]])

    const emit = vi.fn()
    createApiUsageTelemetry({ emit })({
      method: 'POST', route: '/api/v1/projects/:name/google/gsc/sync', statusCode: 200, durationMs: 12,
      userAgent: requests[0]!.headers.get('user-agent') ?? undefined, usageLabels: { surface: 'system', agent: 'none' },
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('fills a route outcome trigger from its request and keeps one the route set', () => {
    handleRouteOutcome({
      event: 'feature.completed',
      properties: { feature: 'ga4', operation: 'sync', status: 'succeeded', counts: { rows: 12 } },
      attribution: { userAgent: 'canonry-cli/7.19.0', surfaceLabel: 'system', agentLabel: 'claude' },
    })
    expect(trackEvent).toHaveBeenLastCalledWith(
      'feature.completed',
      { feature: 'ga4', operation: 'sync', status: 'succeeded', counts: { rows: 12 }, surface: 'system', trigger: 'scheduled' },
      undefined,
    )
    handleRouteOutcome({
      event: 'feature.completed',
      properties: { feature: 'ga4', operation: 'sync', status: 'succeeded' },
      attribution: { userAgent: 'Mozilla/5.0' },
    })
    expect(trackEvent).toHaveBeenLastCalledWith(
      'feature.completed',
      { feature: 'ga4', operation: 'sync', status: 'succeeded', surface: 'dashboard', trigger: 'manual' },
      undefined,
    )
    handleRouteOutcome({
      event: 'feature.completed',
      properties: { feature: 'openai_ads', operation: 'activation', status: 'succeeded', trigger: 'retry' },
    })
    expect(trackEvent).toHaveBeenLastCalledWith(
      'feature.completed',
      { feature: 'openai_ads', operation: 'activation', status: 'succeeded', trigger: 'retry', surface: 'system' },
      undefined,
    )
  })
})

describe('run outcomes', () => {
  it('reports a run the server queued itself as scheduled', () => {
    const db = createTempDb()
    startRunOutcome(db, 'run_scheduled', 'search_console', 'inspect')({ status: 'succeeded', counts: { urls: 3, failures: 0, skipped: 0 } })
    expect(trackEvent).toHaveBeenCalledWith(
      'feature.completed',
      {
        feature: 'search_console', operation: 'inspect', trigger: 'scheduled', surface: 'system',
        status: 'succeeded', durationBucket: 'under_1s', counts: { urls: 3, failures: 0, skipped: 0 },
      },
      undefined,
    )
  })

  it('reports a requested run as its request: an MCP request is an agent trigger', async () => {
    const db = createTempDb()
    await reportFromRequest(db, 'run_manual', {
      'user-agent': 'canonry-mcp', 'x-canonry-surface': 'mcp-stdio', 'x-canonry-agent': 'claude',
    })
    expect(trackEvent).toHaveBeenCalledWith(
      'feature.completed',
      {
        feature: 'search_console', operation: 'sync', trigger: 'agent', surface: 'mcp-stdio', agent: 'claude',
        status: 'succeeded', durationBucket: 'under_1s', counts: { rows: 4 },
      },
      undefined,
    )
  })

  it('reports a sync the data refresh requested as scheduled', async () => {
    const db = createTempDb()
    await reportFromRequest(db, 'run_manual', {
      'user-agent': 'canonry-cli/7.19.0', 'x-canonry-surface': 'system', 'x-canonry-agent': 'claude',
    })
    expect(trackEvent).toHaveBeenCalledWith(
      'feature.completed',
      {
        feature: 'search_console', operation: 'sync', trigger: 'scheduled', surface: 'system',
        status: 'succeeded', durationBucket: 'under_1s', counts: { rows: 4 },
      },
      undefined,
    )
  })

  it('keeps a run the server queued as scheduled even when a request was active', async () => {
    const db = createTempDb()
    await reportFromRequest(db, 'run_scheduled', { 'user-agent': 'Mozilla/5.0' })
    expect(trackEvent).toHaveBeenCalledWith(
      'feature.completed',
      {
        feature: 'search_console', operation: 'sync', trigger: 'scheduled', surface: 'system',
        status: 'succeeded', durationBucket: 'under_1s', counts: { rows: 4 },
      },
      undefined,
    )
  })

  it('reports a manual run started outside a request with its trigger only, and omits empty counts', () => {
    const db = createTempDb()
    startRunOutcome(db, 'run_manual', 'openai_ads', 'sync')({ status: 'skipped', reasonCode: 'NO_DATA', counts: {} })
    expect(trackEvent).toHaveBeenCalledWith(
      'feature.completed',
      { feature: 'openai_ads', operation: 'sync', trigger: 'manual', status: 'skipped', reasonCode: 'NO_DATA', durationBucket: 'under_1s' },
      { errorCode: 'NO_DATA' },
    )
  })

  it('reports a run the server could not start', () => {
    const db = createTempDb()
    reportUnstartedRun(db, 'run_scheduled', 'gbp', 'sync', 'NOT_CONNECTED')
    expect(trackEvent).toHaveBeenCalledWith(
      'feature.completed',
      {
        feature: 'gbp', operation: 'sync', trigger: 'scheduled', surface: 'system',
        status: 'failed', reasonCode: 'NOT_CONNECTED', durationBucket: 'under_1s',
      },
      { errorCode: 'NOT_CONNECTED' },
    )
  })

  it('never throws into the run when sending fails', () => {
    const db = createTempDb()
    trackEvent.mockImplementationOnce(() => { throw new Error('collector down') })
    expect(() => startRunOutcome(db, 'run_manual', 'gbp', 'sync')({ status: 'succeeded' })).not.toThrow()
  })
})

describe('run failures', () => {
  it('prefers the reason attached at the throw site and leaves the error unchanged', () => {
    const err = withOutcomeReason(new Error('No GSC property selected for https://harborline.example.com'), 'PROPERTY_NOT_FOUND')
    expect(err.message).toBe('No GSC property selected for https://harborline.example.com')
    expect(Object.keys(err)).toEqual([])
    expect(runFailure(err)).toEqual({ reasonCode: 'PROPERTY_NOT_FOUND', errorName: 'Error' })
    expect(runFailure(Object.assign(new Error('x'), { status: 401 }))).toEqual({ reasonCode: 'INVALID_CREDENTIALS', errorName: 'Error' })
    expect(runFailure(new Error('x'), 'RATE_LIMITED')).toEqual({ reasonCode: 'RATE_LIMITED', errorName: 'Error' })
  })

  it('reads a failed Google token refresh as a rejected credential unless Google throttled it', () => {
    expect(googleRunFailure(new GoogleAuthError('Token refresh failed (400): invalid_grant'))).toEqual({ reasonCode: 'INVALID_CREDENTIALS', errorName: 'GoogleAuthError' })
    expect(googleRunFailure(new GoogleAuthError('Google OAuth rate limit exceeded', 429))).toEqual({ reasonCode: 'RATE_LIMITED', errorName: 'GoogleAuthError' })
    expect(googleRunFailure(new GoogleApiError('GSC API error (404)', 404))).toEqual({ reasonCode: 'PROPERTY_NOT_FOUND', errorName: 'GoogleApiError' })
    expect(googleRunFailure(new GoogleApiError('GSC API error (403)', 403))).toEqual({ reasonCode: 'PERMISSION_MISSING', errorName: 'GoogleApiError' })
  })
})

describe('sitemap fetch failures', () => {
  let server: http.Server | null = null

  afterEach(() => {
    vi.restoreAllMocks()
    server?.close()
    server = null
  })

  it('tags a missing sitemap, a refused address and an unreachable host with their reasons', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end('Not found')
    })
    await new Promise<void>((resolve) => server!.listen(0, resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    const missing = await fetchAndParseSitemap(`http://127.0.0.1:${port}/sitemap.xml`).catch((err: unknown) => err)
    expect(runFailure(missing)).toEqual({ reasonCode: 'NOT_FOUND', errorName: 'Error' })

    const refused = await fetchAndParseSitemap('http://169.254.169.254/sitemap.xml').catch((err: unknown) => err)
    expect(runFailure(refused)).toEqual({ reasonCode: 'BLOCKED_UNSAFE_URL', errorName: 'Error' })

    vi.spyOn(dns, 'resolve4').mockResolvedValue([])
    vi.spyOn(dns, 'resolve6').mockResolvedValue([])
    const unreachable = await fetchAndParseSitemap('https://gone.example.test/sitemap.xml').catch((err: unknown) => err)
    expect(runFailure(unreachable)).toEqual({ reasonCode: 'NETWORK', errorName: 'Error' })
  })
})
