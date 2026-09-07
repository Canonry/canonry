import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '@ainyc/canonry-api-routes'

// The whole point of this file is the seam BETWEEN the HTTP route and the
// crawl engine: the clamp unit alone cannot prove that an unset --max-edges
// survives normalization, persistence, and the executor hand-off. Only the
// engine call is stubbed.
vi.mock('@canonry/aeo-audit', () => ({ runSiteCrawl: vi.fn() }))
vi.mock('../src/site-audit-root.js', () => ({
  resolveSiteAuditRootUrl: vi.fn(async (url: string) => {
    const normalizedUrl = new URL(url).href
    return { requestedUrl: normalizedUrl, effectiveUrl: normalizedUrl, redirects: [] }
  }),
}))

import { runSiteCrawl } from '@canonry/aeo-audit'
import { executeSiteAudit } from '../src/execute-site-audit.js'

const NOW = '2026-09-03T00:00:00.000Z'

describe('site-audit edge budget through the run route', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>
  let audits: Array<Promise<unknown>>

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-edge-budget-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    db.insert(projects).values({
      id: crypto.randomUUID(), name: 'edge-budget', displayName: 'Edge Budget',
      canonicalDomain: 'example.com', country: 'US', language: 'en', providers: [], locations: [],
      createdAt: NOW, updatedAt: NOW,
    }).run()

    audits = []
    app = Fastify()
    // Mirrors `canonry serve`: the route hands opts straight to the executor.
    app.register(apiRoutes, {
      db,
      skipAuth: true,
      onSiteAuditRequested: (runId, projectId, opts) => {
        audits.push(executeSiteAudit(db, runId, projectId, { ...(opts ?? {}) }).catch(() => undefined))
      },
    })
    await app.ready()

    vi.mocked(runSiteCrawl).mockReset()
    // The crawl itself is out of scope; failing fast keeps the assertion on
    // the options the engine was handed.
    vi.mocked(runSiteCrawl).mockRejectedValue(new Error('engine stubbed'))
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function postRun(payload: Record<string, unknown>): Promise<number> {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/projects/edge-budget/technical-aeo/runs', payload,
    })
    await Promise.all(audits)
    return response.statusCode
  }

  function engineOptions(): Record<string, unknown> {
    expect(vi.mocked(runSiteCrawl)).toHaveBeenCalledTimes(1)
    return vi.mocked(runSiteCrawl).mock.calls[0]![1] as unknown as Record<string, unknown>
  }

  it('reaches runSiteCrawl with no edge budget when the request omits one', async () => {
    expect(await postRun({ maxPages: 8_700 })).toBe(200)
    const options = engineOptions()
    // Undefined, not the old flat 100,000: on a large site that ceiling stops
    // page admission long before the page budget is spent.
    expect(options.maxEdges).toBeUndefined()
    expect(options.maxPages).toBe(8_700)
  })

  it('honours an explicit edge budget exactly', async () => {
    expect(await postRun({ maxPages: 8_700, maxEdges: 435_000 })).toBe(200)
    expect(engineOptions().maxEdges).toBe(435_000)
  })

  it('rejects an edge budget above the contract maximum before any crawl starts', async () => {
    expect(await postRun({ maxEdges: 1_000_001 })).toBe(400)
    expect(vi.mocked(runSiteCrawl)).not.toHaveBeenCalled()
  })
})
