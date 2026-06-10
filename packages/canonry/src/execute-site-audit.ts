import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, projects, siteAuditSnapshots, siteAuditPages } from '@ainyc/canonry-db'
import { runSitemapAudit } from '@ainyc/aeo-audit'
import type { SitemapAuditReport } from '@ainyc/aeo-audit'
import {
  factorStatusFromScore,
  type RunStatus,
  type SiteAuditCrossCuttingIssueDto,
  type SiteAuditFactorSummaryDto,
  type SiteAuditPageFactorDto,
} from '@ainyc/canonry-contracts'
import { resolveWebhookTarget } from '@ainyc/canonry-api-routes'
import { createLogger } from './logger.js'

const log = createLogger('SiteAudit')

/**
 * Default page cap for a single site-audit run. aeo-audit audits pages
 * sequentially and sorts by sitemap `<priority>`, so a generous-but-bounded
 * default keeps the highest-priority pages while preventing a runaway crawl on
 * a very large sitemap. Override per-run via `--limit` / the request body.
 */
export const SITE_AUDIT_DEFAULT_PAGE_LIMIT = 500
/** Hard ceiling — `--limit` cannot exceed this. Mirrors the contract's request cap. */
export const SITE_AUDIT_MAX_PAGE_LIMIT = 2000

export interface SiteAuditOptions {
  /** Override the sitemap URL. Defaults to `https://<canonicalDomain>/sitemap.xml` (aeo-audit derives it from the homepage). */
  sitemapUrl?: string
  /** Max pages to audit (clamped to `[1, SITE_AUDIT_MAX_PAGE_LIMIT]`; defaults to `SITE_AUDIT_DEFAULT_PAGE_LIMIT`). */
  limit?: number
}

type SitemapPage = SitemapAuditReport['pages'][number]
type SitemapPageFactor = NonNullable<SitemapPage['factors']>[number]

function toHomepageUrl(canonicalDomain: string): string {
  const trimmed = canonicalDomain.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * Reject a site-audit URL that resolves to a private / loopback / link-local /
 * cloud-metadata address before any HTTP fetch. Throws a plain `Error` (caught
 * by `executeSiteAudit` and recorded as the run's failure) so an SSRF attempt
 * surfaces as a failed run rather than a server-side request to an internal
 * host. Reuses the shared webhook target validator (DNS-resolves + range-checks
 * every resolved IP).
 */
async function assertSiteAuditUrlAllowed(rawUrl: string, field: string): Promise<void> {
  const check = await resolveWebhookTarget(rawUrl)
  if (!check.ok) {
    throw new Error(`${field} ${check.message.replace(/^"url" /, '')}`)
  }
}

export function clampSiteAuditLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return SITE_AUDIT_DEFAULT_PAGE_LIMIT
  return Math.max(1, Math.min(SITE_AUDIT_MAX_PAGE_LIMIT, Math.floor(limit)))
}

function toPageFactor(factor: SitemapPageFactor): SiteAuditPageFactorDto {
  return {
    id: factor.id,
    name: factor.name,
    weight: factor.weight,
    score: factor.score,
  }
}

/**
 * Roll the per-page factor scores up into a site-level summary for every factor
 * that aeo-audit ran. `avgScore` is the mean across successfully-audited pages;
 * `pagesPassing + pagesPartial + pagesFailing` equals the success-page count for
 * each factor (every successful audit reports all factors).
 */
export function computeFactorAverages(pages: SitemapPage[]): SiteAuditFactorSummaryDto[] {
  const byId = new Map<string, { name: string; weight: number; scores: number[]; pass: number; partial: number; fail: number }>()
  for (const page of pages) {
    if (page.status !== 'success' || !page.factors) continue
    for (const factor of page.factors) {
      let entry = byId.get(factor.id)
      if (!entry) {
        entry = { name: factor.name, weight: factor.weight, scores: [], pass: 0, partial: 0, fail: 0 }
        byId.set(factor.id, entry)
      }
      entry.scores.push(factor.score)
      const status = factorStatusFromScore(factor.score)
      if (status === 'pass') entry.pass++
      else if (status === 'partial') entry.partial++
      else entry.fail++
    }
  }
  const summaries: SiteAuditFactorSummaryDto[] = []
  for (const [id, entry] of byId) {
    const avgScore = entry.scores.length
      ? Math.round(entry.scores.reduce((sum, score) => sum + score, 0) / entry.scores.length)
      : 0
    summaries.push({
      id,
      name: entry.name,
      weight: entry.weight,
      avgScore,
      status: factorStatusFromScore(avgScore),
      pagesPassing: entry.pass,
      pagesPartial: entry.partial,
      pagesFailing: entry.fail,
    })
  }
  // Heaviest-weighted factors first — matches aeo-audit's factor ordering importance.
  summaries.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
  return summaries
}

/**
 * Execute a Technical AEO site audit: crawl the project's sitemap via
 * `runSitemapAudit`, persist a per-run snapshot + per-page rows, and set the
 * run status. Modeled on `executeInspectSitemap`. The caller fires
 * `RunCoordinator.onRunCompleted` after this resolves.
 */
export async function executeSiteAudit(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: SiteAuditOptions = {},
): Promise<void> {
  const startedAt = new Date().toISOString()
  db.update(runs).set({ status: 'running', startedAt }).where(eq(runs.id, runId)).run()

  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const homepageUrl = toHomepageUrl(project.canonicalDomain)
    const limit = clampSiteAuditLimit(opts.limit)
    log.info('start', { runId, projectId, homepageUrl, sitemapUrl: opts.sitemapUrl ?? null, limit })

    // SSRF guard. `runSitemapAudit` fetches the sitemap URL verbatim with no
    // host validation of its own (aeo-audit only guards the per-page `<loc>`
    // fetches, not the initial sitemap/discovery fetch). The request-body
    // `sitemapUrl` is attacker-controlled, so validate both the homepage origin
    // (used for sitemap discovery) and any explicit sitemap URL resolve to a
    // public address before crawling. Canonry never opts into private hosts for
    // site audits, so loopback is blocked too.
    await assertSiteAuditUrlAllowed(homepageUrl, 'canonicalDomain')
    if (opts.sitemapUrl) await assertSiteAuditUrlAllowed(opts.sitemapUrl, 'sitemapUrl')

    // Pure HTTP — no LLM / paid API calls. Runs sequentially inside the package.
    const report = await runSitemapAudit(homepageUrl, { sitemapUrl: opts.sitemapUrl, limit })

    const successCount = report.pages.filter((page) => page.status === 'success').length
    const pagesErrored = report.pages.filter((page) => page.status === 'error').length

    // No silent caps: if the sitemap had more auditable pages than the limit, say so.
    const auditable = report.pagesDiscovered - report.pagesSkipped
    if (auditable > report.pagesAudited) {
      log.info('truncated', {
        runId,
        projectId,
        auditable,
        audited: report.pagesAudited,
        dropped: auditable - report.pagesAudited,
        limit,
      })
    }

    if (successCount === 0) {
      throw new Error(
        `Site audit could not successfully audit any of ${report.pagesAudited} page(s) from ${report.sitemapUrl}.`,
      )
    }

    const factorAverages = computeFactorAverages(report.pages)
    const status: RunStatus = pagesErrored === 0 ? 'completed' : 'partial'
    const finishedAt = new Date().toISOString()

    db.transaction((tx) => {
      tx.insert(siteAuditSnapshots).values({
        id: crypto.randomUUID(),
        projectId,
        runId,
        sitemapUrl: report.sitemapUrl,
        auditedAt: report.auditedAt,
        aggregateScore: report.aggregateScore,
        pagesDiscovered: report.pagesDiscovered,
        pagesAudited: report.pagesAudited,
        pagesSkipped: report.pagesSkipped,
        pagesErrored,
        factorAverages,
        // aeo-audit v3 enriches these (topIssues, avgGrade-free); keep only the
        // fields our DTO exposes so the stored JSON stays lean.
        crossCuttingIssues: report.crossCuttingIssues.map((issue): SiteAuditCrossCuttingIssueDto => ({
          factorId: issue.factorId,
          factorName: issue.factorName,
          avgScore: issue.avgScore,
          affectedPages: issue.affectedPages,
          totalPages: issue.totalPages,
          affectedPct: issue.totalPages > 0 ? Math.round((issue.affectedPages / issue.totalPages) * 100) : 0,
          topRecommendations: issue.topRecommendations,
        })),
        // v3 prioritizedFixes are structured PrioritizedFix objects; persist the
        // ready-to-display one-line summary to keep the DTO a string list.
        prioritizedFixes: report.prioritizedFixes.map((fix) => fix.summary),
        createdAt: finishedAt,
      }).run()

      for (const page of report.pages) {
        tx.insert(siteAuditPages).values({
          id: crypto.randomUUID(),
          projectId,
          runId,
          url: page.url,
          overallScore: page.overallScore,
          status: page.status,
          error: page.error ?? null,
          factors: (page.factors ?? []).map(toPageFactor),
          createdAt: finishedAt,
        }).run()
      }

      tx.update(runs).set({ status, finishedAt }).where(eq(runs.id, runId)).run()
    })

    log.info('completed', {
      runId,
      projectId,
      status,
      score: report.aggregateScore,
      audited: report.pagesAudited,
      errored: pagesErrored,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    db.update(runs)
      .set({ status: 'failed', error: errorMsg, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, runId))
      .run()
    log.error('failed', { runId, projectId, error: errorMsg })
    throw err
  }
}
