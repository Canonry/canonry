import crypto from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, gscUrlInspections, gscCoverageSnapshots } from '@ainyc/canonry-db'
import {
  inspectUrl,
  refreshAccessToken,
} from '@ainyc/canonry-integration-google'
import type { CanonryConfig } from './config.js'
import { saveConfig } from './config.js'
import { getGoogleAuthConfig, getGoogleConnection, patchGoogleConnection } from './google-config.js'
import { fetchAndParseSitemap } from './sitemap-parser.js'
import { createLogger } from './logger.js'

const log = createLogger('InspectSitemap')

interface InspectSitemapOptions {
  sitemapUrl?: string
  config: CanonryConfig
}

export async function executeInspectSitemap(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: InspectSitemapOptions,
): Promise<void> {
  const now = new Date().toISOString()

  // Mark run as running
  db.update(runs).set({ status: 'running', startedAt: now }).where(eq(runs.id, runId)).run()

  try {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getGoogleAuthConfig(opts.config)
    if (!googleClientId || !googleClientSecret) {
      throw new Error('Google OAuth is not configured in the local Canonry config')
    }

    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const conn = getGoogleConnection(opts.config, project.canonicalDomain, 'gsc')
    if (!conn || !conn.refreshToken) {
      throw new Error('No GSC connection found or connection is incomplete')
    }

    if (!conn.propertyId) {
      throw new Error('No GSC property selected. Use "canonry google properties" to list available sites, then set one.')
    }

    // Refresh token if needed
    let accessToken = conn.accessToken!
    const expiresAt = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() : 0
    if (Date.now() > expiresAt - 5 * 60 * 1000) {
      const tokens = await refreshAccessToken(googleClientId, googleClientSecret, conn.refreshToken)
      accessToken = tokens.access_token
      patchGoogleConnection(opts.config, project.canonicalDomain, 'gsc', {
        accessToken: tokens.access_token,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      })
      saveConfig(opts.config)
    }

    // Determine sitemap URL: explicit > stored on connection > default
    const sitemapUrl = opts.sitemapUrl || conn.sitemapUrl || `https://${project.canonicalDomain}/sitemap.xml`
    log.info('sitemap.fetch', { runId, projectId, sitemapUrl })

    const urls = await fetchAndParseSitemap(sitemapUrl)
    log.info('sitemap.parsed', { runId, projectId, urlCount: urls.length, sitemapUrl })

    if (urls.length === 0) {
      throw new Error('No URLs found in sitemap')
    }

    let inspected = 0
    let errors = 0

    for (const pageUrl of urls) {
      try {
        const result = await inspectUrl(accessToken, pageUrl, conn.propertyId)
        const ir = result.inspectionResult
        const idx = ir.indexStatusResult
        const mob = ir.mobileUsabilityResult
        const rich = ir.richResultsResult
        const inspectedAt = new Date().toISOString()

        db.insert(gscUrlInspections).values({
          id: crypto.randomUUID(),
          projectId,
          syncRunId: runId,
          url: pageUrl,
          indexingState: idx?.indexingState ?? null,
          verdict: idx?.verdict ?? null,
          coverageState: idx?.coverageState ?? null,
          pageFetchState: idx?.pageFetchState ?? null,
          robotsTxtState: idx?.robotsTxtState ?? null,
          crawlTime: idx?.lastCrawlTime ?? null,
          lastCrawlResult: idx?.crawlResult ?? null,
          isMobileFriendly: mob?.verdict === 'PASS' ? 1 : mob?.verdict === 'FAIL' ? 0 : null,
          richResults: JSON.stringify(rich?.detectedItems?.map((d) => d.richResultType) ?? []),
          referringUrls: JSON.stringify(idx?.referringUrls ?? []),
          inspectedAt,
          createdAt: inspectedAt,
        }).run()

        inspected++
        log.info('inspect.url-done', { runId, projectId, url: pageUrl, progress: `${inspected}/${urls.length}` })
      } catch (err) {
        errors++
        log.error('inspect.url-failed', { runId, projectId, url: pageUrl, error: err instanceof Error ? err.message : String(err) })
      }

      // Rate limit: ~1 request per second to stay within API quotas
      if (inspected + errors < urls.length) {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    // Record coverage snapshot
    const allInspections = db
      .select()
      .from(gscUrlInspections)
      .where(eq(gscUrlInspections.projectId, projectId))
      .all()

    const latestByUrl = new Map<string, typeof allInspections[number]>()
    for (const row of allInspections) {
      const existing = latestByUrl.get(row.url)
      if (!existing || row.inspectedAt > existing.inspectedAt) {
        latestByUrl.set(row.url, row)
      }
    }

    let snapIndexed = 0
    let snapNotIndexed = 0
    const reasonCounts: Record<string, number> = {}
    for (const [, row] of latestByUrl) {
      if (row.indexingState === 'INDEXING_ALLOWED') {
        snapIndexed++
      } else {
        snapNotIndexed++
        const reason = row.coverageState ?? 'Unknown'
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
      }
    }

    const snapshotDate = new Date().toISOString().split('T')[0]!
    db.delete(gscCoverageSnapshots)
      .where(and(eq(gscCoverageSnapshots.projectId, projectId), eq(gscCoverageSnapshots.date, snapshotDate)))
      .run()
    db.insert(gscCoverageSnapshots).values({
      id: crypto.randomUUID(),
      projectId,
      syncRunId: runId,
      date: snapshotDate,
      indexed: snapIndexed,
      notIndexed: snapNotIndexed,
      reasonBreakdown: JSON.stringify(reasonCounts),
      createdAt: new Date().toISOString(),
    }).run()

    // Mark run as completed (or partial if some failed)
    const status = errors > 0 && inspected > 0 ? 'partial' : errors === urls.length ? 'failed' : 'completed'
    db.update(runs)
      .set({ status, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.info('inspect.completed', { runId, projectId, inspected, errors, total: urls.length, indexed: snapIndexed, notIndexed: snapNotIndexed })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    db.update(runs)
      .set({ status: 'failed', error: errorMsg, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.error('inspect.failed', { runId, projectId, error: errorMsg })
    throw err
  }
}
