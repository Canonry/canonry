import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, gscUrlInspections } from '@ainyc/canonry-db'
import {
  inspectUrl,
  refreshAccessToken,
} from '@ainyc/canonry-integration-google'
import type { CanonryConfig } from './config.js'
import { saveConfigPatch } from './config.js'
import { getGoogleAuthConfig, getGoogleConnection, patchGoogleConnection } from './google-config.js'
import { fetchAndParseSitemap } from './sitemap-parser.js'
import { writeCoverageSnapshot } from './gsc-coverage-snapshot.js'
import { createLogger } from './logger.js'
import { inspectUrlsPaced, INSPECT_FAILFAST_THRESHOLD, INSPECT_SWEEP_MAX_URLS, INSPECT_DAILY_QUOTA } from './gsc-inspect-paced.js'
import { describeError, FeatureNames, OutcomeReasonCodes, OutcomeStatuses, RunStatuses } from '@ainyc/canonry-contracts'
import { googleRunFailure, startRunOutcome, withOutcomeReason } from './sync-outcome.js'

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
  const reportOutcome = startRunOutcome(db, runId, FeatureNames.search_console, 'inspect')
  // The error a breaker trip wraps, so the outcome reports its cause.
  let abortCause: unknown
  const now = new Date().toISOString()

  // Mark run as running
  db.update(runs).set({ status: 'running', startedAt: now }).where(eq(runs.id, runId)).run()

  try {
    const { clientId: googleClientId, clientSecret: googleClientSecret } = getGoogleAuthConfig(opts.config)
    if (!googleClientId || !googleClientSecret) {
      throw withOutcomeReason(new Error('Google OAuth is not configured in the local Canonry config'), OutcomeReasonCodes.NOT_CONNECTED)
    }

    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw withOutcomeReason(new Error(`Project not found: ${projectId}`), OutcomeReasonCodes.NOT_FOUND)
    }

    const conn = getGoogleConnection(opts.config, project.canonicalDomain, 'gsc')
    if (!conn || !conn.refreshToken) {
      throw withOutcomeReason(new Error('No GSC connection found or connection is incomplete'), OutcomeReasonCodes.NOT_CONNECTED)
    }

    if (!conn.propertyId) {
      throw withOutcomeReason(
        new Error('No GSC property selected. Use "canonry google properties" to list available sites, then set one.'),
        OutcomeReasonCodes.PROPERTY_NOT_FOUND,
      )
    }
    const propertyId = conn.propertyId

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
      saveConfigPatch(opts.config)
    }

    // Determine sitemap URL: explicit > stored on connection > default
    const sitemapUrl = opts.sitemapUrl || conn.sitemapUrl || `https://${project.canonicalDomain}/sitemap.xml`
    log.info('sitemap.fetch', { runId, projectId, sitemapUrl })

    const urls = await fetchAndParseSitemap(sitemapUrl)
    log.info('sitemap.parsed', { runId, projectId, urlCount: urls.length, sitemapUrl })

    if (urls.length === 0) {
      throw withOutcomeReason(new Error('No URLs found in sitemap'), OutcomeReasonCodes.NO_DATA)
    }

    // A sweep larger than the budget cannot finish: at ~7.1s and one quota unit
    // per URL it would run for hours, exhaust the property's 2000/day partway,
    // and trip the consecutive-failure breaker — surfacing as a failure when
    // what actually happened is that the allowance ran out. Cap it and say so,
    // rather than starting work that cannot complete.
    const skipped = Math.max(0, urls.length - INSPECT_SWEEP_MAX_URLS)
    const targetUrls = skipped > 0 ? urls.slice(0, INSPECT_SWEEP_MAX_URLS) : urls
    if (skipped > 0) {
      log.warn('sitemap.over-budget', {
        runId,
        projectId,
        sitemapUrls: urls.length,
        inspecting: targetUrls.length,
        skipped,
        dailyQuota: INSPECT_DAILY_QUOTA,
        note: `Sitemap has ${urls.length} pages; Google allows ${INSPECT_DAILY_QUOTA} URL inspections per property per day. Inspecting the first ${targetUrls.length}; ${skipped} pages will not have a verdict from this run.`,
      })
    }

    let lastInspectError: unknown
    const { inspected, errors, aborted, abortError } = await inspectUrlsPaced(
      targetUrls,
      {
        inspectOne: (pageUrl) => inspectUrl(accessToken, pageUrl, propertyId),
        onResult: (pageUrl, result, index) => {
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
            isMobileFriendly: mob?.verdict === 'PASS' ? true : mob?.verdict === 'FAIL' ? false : null,
            richResults: rich?.detectedItems?.map((d) => d.richResultType) ?? [],
            referringUrls: idx?.referringUrls ?? [],
            inspectedAt,
            createdAt: inspectedAt,
          }).run()

          log.info('inspect.url-done', { runId, projectId, url: pageUrl, progress: `${index + 1}/${urls.length}` })
        },
        onError: (pageUrl, err) => {
          lastInspectError = err
          log.error('inspect.url-failed', { runId, projectId, url: pageUrl, error: describeError(err) })
        },
      },
      {
        // Google meters URL Inspection per PROPERTY, so every sweep on this
        // property queues behind one clock. Latent rather than urgent here (a
        // property has one project today), but the per-call gate had the same
        // defect Bing was bitten by, and a manual sweep racing the chained
        // coverage refresh is exactly the overlap it fails on.
        rateGateKey: `gsc:${propertyId}`,
        log: {
          info: (action, ctx) => log.info(action, { runId, projectId, ...ctx }),
          error: (action, ctx) => log.error(action, { runId, projectId, ...ctx }),
        },
      },
    )

    if (aborted) {
      abortCause = abortError
      const detail = describeError(abortError)
      throw new Error(
        `URL inspection aborted after ${INSPECT_FAILFAST_THRESHOLD} consecutive rate/access failures (likely GSC URL Inspection quota exhaustion or property access loss). Last error: ${detail}`,
      )
    }

    // Record coverage snapshot
    // Single writer — see gsc-coverage-snapshot.ts. This run chains off
    // gsc-sync and rewrites the same (project, date) row, so computing coverage
    // independently here silently overwrote what gsc-sync derived and reset the
    // provenance columns to their defaults.
    const coverage = writeCoverageSnapshot(db, projectId, runId)
    const snapIndexed = coverage.indexed
    const snapNotIndexed = coverage.notIndexed

    // Mark run as completed (or partial if some failed)
    const attempted = targetUrls.length
    // Over-budget is a partial result even when every attempted URL succeeded —
    // pages were left unverified and the run should not read as complete.
    const status = skipped > 0 || (errors > 0 && inspected > 0) ? 'partial' : errors === attempted ? 'failed' : 'completed'
    db.update(runs)
      .set({ status, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.info('inspect.completed', { runId, projectId, inspected, errors, total: urls.length, indexed: snapIndexed, notIndexed: snapNotIndexed })
    const counts = { urls: inspected, failures: errors, skipped }
    if (status === RunStatuses.completed) {
      reportOutcome({ status: OutcomeStatuses.succeeded, counts })
    } else {
      // Over budget with no failed URL is the daily inspection quota capping the sweep.
      const failure = errors > 0 ? googleRunFailure(lastInspectError) : { reasonCode: OutcomeReasonCodes.QUOTA_EXCEEDED }
      reportOutcome({ status: status === RunStatuses.partial ? OutcomeStatuses.partial : OutcomeStatuses.failed, ...failure, counts })
    }
  } catch (err) {
    const errorMsg = describeError(err)
    db.update(runs)
      .set({ status: 'failed', error: errorMsg, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()

    log.error('inspect.failed', { runId, projectId, error: errorMsg })
    const failure = googleRunFailure(abortCause ?? err)
    reportOutcome({
      status: failure.reasonCode === OutcomeReasonCodes.NO_DATA ? OutcomeStatuses.skipped : OutcomeStatuses.failed,
      ...failure,
    })
    throw err
  }
}
