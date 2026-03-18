import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { querySnapshots, runs, keywords } from '@ainyc/canonry-db'
import type { GroundingSource } from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

export interface CDPRoutesOptions {
  /** Callback to get CDP connection status */
  getCdpStatus?: () => Promise<{
    connected: boolean
    endpoint: string
    version?: string
    browserVersion?: string
    targets: { name: string; alive: boolean; lastUsed: string | null }[]
  }>
  /** Callback to execute a one-off CDP screenshot query */
  onCdpScreenshot?: (query: string, targets?: string[]) => Promise<{
    target: string
    screenshotPath: string
    answerText: string
    citations: GroundingSource[]
  }[]>
  /** Callback to configure the CDP endpoint (host + port) */
  onCdpConfigure?: (host: string, port: number) => Promise<void> | void
}

function getScreenshotDir(): string {
  return path.join(os.homedir(), '.canonry', 'screenshots')
}

export async function cdpRoutes(app: FastifyInstance, opts: CDPRoutesOptions) {

  // GET /screenshots/:snapshotId — serve a screenshot PNG
  app.get<{ Params: { snapshotId: string } }>('/screenshots/:snapshotId', async (request, reply) => {
    const { snapshotId } = request.params

    const snapshot = app.db
      .select({ screenshotPath: querySnapshots.screenshotPath })
      .from(querySnapshots)
      .where(eq(querySnapshots.id, snapshotId))
      .get()

    if (!snapshot?.screenshotPath) {
      return reply.code(404).send({ error: 'Screenshot not found' })
    }

    const base = path.resolve(getScreenshotDir())
    const fullPath = path.resolve(path.join(base, snapshot.screenshotPath))
    // Prevent path traversal: ensure resolved path stays within base dir
    if (!fullPath.startsWith(base + path.sep) && fullPath !== base) {
      return reply.code(404).send({ error: 'Screenshot not found' })
    }
    if (!fs.existsSync(fullPath)) {
      return reply.code(404).send({ error: 'Screenshot file not found on disk' })
    }

    const stream = fs.createReadStream(fullPath)
    return reply.type('image/png').send(stream)
  })

  // PUT /settings/cdp — configure the CDP endpoint (host + port)
  app.put<{ Body: { host: string; port?: number } }>('/settings/cdp', async (request, reply) => {
    if (!opts.onCdpConfigure) {
      return reply.code(501).send({ error: 'CDP configuration not supported in this deployment' })
    }
    const { host, port = 9222 } = request.body
    if (!host || typeof host !== 'string') {
      return reply.code(400).send({ error: 'host is required' })
    }
    // Restrict to loopback addresses only — arbitrary hosts would allow SSRF
    const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1']
    if (!ALLOWED_HOSTS.includes(host)) {
      return reply.code(400).send({ error: 'host must be localhost, 127.0.0.1, or ::1' })
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return reply.code(400).send({ error: 'port must be an integer between 1 and 65535' })
    }
    await opts.onCdpConfigure(host, port)
    return reply.code(200).send({ endpoint: `ws://${host}:${port}` })
  })

  // GET /cdp/status — CDP connection health + tab status
  app.get('/cdp/status', async (_request, reply) => {
    if (!opts.getCdpStatus) {
      return reply.code(501).send({ error: 'CDP not configured' })
    }
    const status = await opts.getCdpStatus()
    return reply.send(status)
  })

  // POST /cdp/screenshot — one-off screenshot query (not tied to a project/run)
  app.post<{ Body: { query: string; targets?: string[] } }>('/cdp/screenshot', async (request, reply) => {
    if (!opts.onCdpScreenshot) {
      return reply.code(501).send({ error: 'CDP not configured' })
    }

    const { query, targets } = request.body
    if (!query || typeof query !== 'string') {
      return reply.code(400).send({ error: 'query is required' })
    }

    const results = await opts.onCdpScreenshot(query, targets)
    return reply.code(200).send({ results })
  })

  // GET /projects/:name/runs/:runId/browser-diff — API vs Browser comparison
  app.get<{ Params: { name: string; runId: string } }>(
    '/projects/:name/runs/:runId/browser-diff',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)

      const { runId } = request.params

      // Verify run belongs to this project
      const run = app.db
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.projectId, project.id)))
        .get()
      if (!run) return reply.code(404).send({ error: 'Run not found' })

      // Get all snapshots for this run
      const snapshots = app.db
        .select({
          id: querySnapshots.id,
          keywordId: querySnapshots.keywordId,
          provider: querySnapshots.provider,
          citationState: querySnapshots.citationState,
          citedDomains: querySnapshots.citedDomains,
          screenshotPath: querySnapshots.screenshotPath,
          rawResponse: querySnapshots.rawResponse,
        })
        .from(querySnapshots)
        .where(eq(querySnapshots.runId, runId))
        .all()

      // Get keyword names
      const keywordRows = app.db
        .select({ id: keywords.id, keyword: keywords.keyword })
        .from(keywords)
        .where(eq(keywords.projectId, project.id))
        .all()
      const keywordMap = new Map(keywordRows.map(k => [k.id, k.keyword]))

      // Group snapshots by keyword, separate API (openai) from browser (cdp:chatgpt)
      const byKeyword = new Map<string, {
        keyword: string
        api: typeof snapshots[number] | null
        browser: typeof snapshots[number] | null
      }>()

      for (const snap of snapshots) {
        const kwName = keywordMap.get(snap.keywordId) ?? snap.keywordId
        if (!byKeyword.has(snap.keywordId)) {
          byKeyword.set(snap.keywordId, { keyword: kwName, api: null, browser: null })
        }
        const entry = byKeyword.get(snap.keywordId)!
        if (snap.provider === 'cdp:chatgpt') {
          entry.browser = snap
        } else if (snap.provider === 'openai') {
          entry.api = snap
        }
      }

      // Build comparison results
      let agreed = 0
      let apiOnlyCited = 0
      let browserOnlyCited = 0
      let disagreed = 0
      let total = 0

      const keywordResults = [...byKeyword.values()].map(({ keyword, api, browser }) => {
        total++
        const apiCited = api?.citationState === 'cited'
        const browserCited = browser?.citationState === 'cited'

        let agreement: string
        if (!api && !browser) {
          agreement = 'no-data'
        } else if (!api) {
          agreement = 'no-api'
        } else if (!browser) {
          agreement = 'no-browser'
        } else if (apiCited && browserCited) {
          agreement = 'agree-cited'
          agreed++
        } else if (!apiCited && !browserCited) {
          agreement = 'agree-not-cited'
          agreed++
        } else if (apiCited && !browserCited) {
          agreement = 'api-only-cited'
          apiOnlyCited++
          disagreed++
        } else {
          agreement = 'browser-only-cited'
          browserOnlyCited++
          disagreed++
        }

        const parseGroundingSources = (snap: typeof snapshots[number] | null): GroundingSource[] => {
          if (!snap?.rawResponse) return []
          try {
            const raw = JSON.parse(snap.rawResponse)
            return (raw.groundingSources as GroundingSource[]) ?? []
          } catch { return [] }
        }

        return {
          keyword,
          api: api ? {
            provider: api.provider,
            citationState: api.citationState,
            citedDomains: JSON.parse(api.citedDomains || '[]'),
            groundingSources: parseGroundingSources(api),
          } : null,
          browser: browser ? {
            provider: browser.provider,
            citationState: browser.citationState,
            citedDomains: JSON.parse(browser.citedDomains || '[]'),
            groundingSources: parseGroundingSources(browser),
            screenshotUrl: browser.screenshotPath ? `/api/v1/screenshots/${browser.id}` : undefined,
          } : null,
          agreement,
        }
      })

      return reply.send({
        summary: { total, agreed, apiOnly: apiOnlyCited, browserOnly: browserOnlyCited, disagreed },
        keywords: keywordResults,
      })
    },
  )
}
