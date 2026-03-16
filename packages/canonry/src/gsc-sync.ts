import crypto from 'node:crypto'
import { eq, and, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, gscSearchData, gscUrlInspections, gscCoverageSnapshots } from '@ainyc/canonry-db'
import {
  fetchSearchAnalytics,
  inspectUrl,
  refreshAccessToken,
  GSC_DATA_LAG_DAYS,
} from '@ainyc/canonry-integration-google'
import type { CanonryConfig } from './config.js'
import { saveConfig } from './config.js'
import { getGoogleAuthConfig, getGoogleConnection, patchGoogleConnection } from './google-config.js'

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]!
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

interface GscSyncOptions {
  days?: number
  full?: boolean
  config: CanonryConfig
}

export async function executeGscSync(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: GscSyncOptions,
): Promise<void> {
  const now = new Date().toISOString()

  // Mark run as running
  db.update(runs).set({ status: 'running', startedAt: now }).where(eq(runs.id, runId)).run()

  try {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getGoogleAuthConfig(opts.config)
    if (!googleClientId || !googleClientSecret) {
      throw new Error('Google OAuth is not configured in the local Canonry config')
    }

    // Load the project to get canonicalDomain for domain-scoped connection lookup
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const conn = getGoogleConnection(opts.config, project.canonicalDomain, 'gsc')
    if (!conn || !conn.refreshToken) {
      throw new Error('No GSC connection found or connection is incomplete')
    }

    if (!conn.propertyId) {
      throw new Error('No GSC property selected. Use "canonry google properties" to list available sites, then set one with the API.')
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

    // Determine date range
    const lagOffset = GSC_DATA_LAG_DAYS
    const endDate = formatDate(daysAgo(lagOffset))
    const days = opts.full ? 480 : (opts.days ?? 30) // 480 days ≈ 16 months (GSC max)
    const startDate = formatDate(daysAgo(days + lagOffset))

    // Fetch search analytics with pagination
    console.log(`[GSC Sync] Fetching search analytics for ${conn.propertyId} from ${startDate} to ${endDate}`)
    const rows = await fetchSearchAnalytics(accessToken, conn.propertyId, {
      startDate,
      endDate,
    })

    console.log(`[GSC Sync] Received ${rows.length} rows`)

    // Delete existing rows for this project in the same date range to avoid duplicates on re-sync
    db.delete(gscSearchData)
      .where(
        and(
          eq(gscSearchData.projectId, projectId),
          sql`${gscSearchData.date} >= ${startDate}`,
          sql`${gscSearchData.date} <= ${endDate}`,
        )
      )
      .run()

    // Store rows in batches
    const batchSize = 500
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize)
      const insertNow = new Date().toISOString()

      for (const row of batch) {
        // keys order matches dimensions: query, page, country, device, date
        const [query, page, country, device, date] = row.keys
        db.insert(gscSearchData).values({
          id: crypto.randomUUID(),
          projectId,
          syncRunId: runId,
          date: date ?? '',
          query: query ?? '',
          page: page ?? '',
          country: country ?? null,
          device: device ?? null,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: String(row.ctr),
          position: String(row.position),
          createdAt: insertNow,
        }).run()
      }
    }

    // URL inspections — inspect top pages from the fetched data
    // Aggregate clicks per page, take top N
    const pageClicks = new Map<string, number>()
    for (const row of rows) {
      const page = row.keys[1]
      if (page) {
        pageClicks.set(page, (pageClicks.get(page) ?? 0) + row.clicks)
      }
    }

    const topPages = [...pageClicks.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50) // Inspect top 50 pages by clicks
      .map(([page]) => page)

    console.log(`[GSC Sync] Inspecting ${topPages.length} URLs`)

    for (const pageUrl of topPages) {
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
      } catch (err) {
        // Log but don't fail the whole sync for individual inspection errors
        console.error(`[GSC Sync] Failed to inspect ${pageUrl}:`, err instanceof Error ? err.message : err)
      }
    }

    // Record coverage snapshot from all inspections for this project (latest per URL)
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

    const snapshotDate = formatDate(new Date())
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

    // Mark run as completed
    db.update(runs)
      .set({ status: 'completed', finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    console.log(`[GSC Sync] Completed. ${rows.length} search data rows, ${topPages.length} URL inspections, coverage snapshot: ${snapIndexed} indexed / ${snapNotIndexed} not-indexed.`)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    db.update(runs)
      .set({ status: 'failed', error: errorMsg, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    console.error(`[GSC Sync] Failed:`, errorMsg)
    throw err
  }
}
