import { runSiteCrawl } from 'npm:@canonry/aeo-audit@7.2.0'
import type { CrawlPageObservation, SiteCrawlOptions, SiteCrawlReport } from 'npm:@canonry/aeo-audit@7.2.0'
import { wwwAlternate } from 'npm:@canonry/val-kit@0.2.0/security'
import { buildSiteMap } from './site-map.ts'
import type { FactorSample, SiteHealthPageSample, SiteHealthRunner, SiteHealthSample } from './types.ts'

export const VAL_TOWN_SITE_HEALTH_LIMITS = Object.freeze({
  mode: 'full' as const,
  maxPages: 5,
  maxEdges: 2_500,
  maxFetches: 32,
  maxDurationMs: 20_000,
  maxBytes: 12 * 1024 * 1024,
  maxPageBytes: 2 * 1024 * 1024,
  maxDepth: 2,
  maxLinksPerPage: 250,
  maxQueryVariants: 2,
  maxSitemapFanout: 8,
  maxSitemapUrls: 250,
  concurrency: 2,
  requestDelayMs: 100,
  respectRobots: true,
  checkDeadLinks: false,
  includeGeo: false,
  includeAgentSkills: false,
  includeLighthouse: false,
}) satisfies SiteCrawlOptions

type Crawl = (rootUrl: string, options: SiteCrawlOptions) => Promise<SiteCrawlReport>

export function createSiteHealthRunner(crawl: Crawl = runSiteCrawl): SiteHealthRunner {
  return {
    async run(domain, parentSignal) {
      const hosts = [domain, wwwAlternate(domain)].filter((value): value is string => Boolean(value))
      const attemptedHosts: string[] = []
      const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)])
      let primaryError: unknown = null

      for (let index = 0; index < hosts.length; index++) {
        const host = hosts[index]!
        attemptedHosts.push(host)
        try {
          // `allowPrivateHost` names the ONE host being crawled, which is what
          // makes Technical AEO possible on Val Town at all.
          //
          // The engine's SSRF guard resolves every hostname with DNS and rejects
          // private addresses before opening a socket. Val Town grants no DNS:
          // `Deno.resolveDns` lacks net access to the resolver and
          // `node:dns.resolve4` returns UNKNOWN, so the guard failed closed on
          // every host and the crawl audited zero pages for every domain.
          //
          // This is not a way to switch the guard off; the option is a hostname,
          // not a boolean, precisely so it cannot be. A matching host skips the
          // DNS preflight and IP pinning (fetch-page.ts), and every OTHER host —
          // a redirect to cloud metadata, an internal service reached from a
          // sitemap — is still resolved and still blocked.
          //
          // `host` is safe to name because `normalizePublicDomain` has already
          // rejected localhost, .local, every private IPv4 range and all IPv6
          // literals before this runs. If it nonetheless rebinds to a private
          // address, Val Town's own sandbox refuses the fetch: 169.254.169.254,
          // 127.0.0.1, 10/8 and 192.168/16 all fail with "Requires net access"
          // before a socket opens.
          const report = await crawl(`https://${host}/`, {
            ...VAL_TOWN_SITE_HEALTH_LIMITS,
            allowPrivateHost: host,
            signal,
          })
          if (index === 0 && hosts[1] && shouldTryWwwAlternate(report, hosts[1])) continue
          return toSample(domain, report, attemptedHosts)
        } catch (error) {
          primaryError ??= error
        }
      }

      return failedSample(domain, attemptedHosts, safeError(primaryError))
    },
  }
}

function shouldTryWwwAlternate(report: SiteCrawlReport, alternateHost: string): boolean {
  if (report.summary.pagesFetched === 0 && report.summary.pagesObserved === 0) return true
  if (report.summary.terminationReason !== 'root-host-redirect' || !report.summary.finalRootUrl) return false
  try {
    return new URL(report.summary.finalRootUrl).hostname.toLowerCase().replace(/\.$/, '') === alternateHost
  } catch {
    return false
  }
}

function toSample(domain: string, report: SiteCrawlReport, attemptedHosts: string[]): SiteHealthSample {
  const summary = report.summary
  const pages = report.mode === 'full' ? report.pages.map(toPage).sort(sortWorstFirst).slice(0, 5) : []
  // Built from the full observation set, not the worst-first five above: the
  // graph's value is the links between pages, and slicing first would sever them.
  const siteMap = report.mode === 'full' ? buildSiteMap(report.pages, report.edges) : null
  // v7 always reports this count. Treat a missing legacy/mock field as unknown
  // rather than inventing an error; an explicit zero is never a valid sample.
  const hasAuditedPages = summary.auditRollup.auditedPages !== 0
  const status = !hasAuditedPages
    ? 'error'
    : isCompleteBoundedSample(summary.terminationReason)
    ? 'complete'
    : 'partial'
  return {
    schemaVersion: summary.crawlSchemaVersion,
    label: '5-page Technical AEO sample',
    domain,
    rootUrl: summary.rootUrl,
    finalRootUrl: summary.finalRootUrl,
    status,
    score: hasAuditedPages ? summary.auditRollup.aggregateScore : null,
    pagesDiscovered: summary.pagesDiscovered,
    pagesFetched: summary.pagesFetched,
    pagesObserved: summary.pagesObserved,
    elapsedMs: summary.elapsedMs,
    terminationReason: summary.terminationReason,
    // Warnings may carry transport diagnostics from the crawler. Keep the
    // public record descriptive without persisting those raw messages.
    warnings: summary.warnings.slice(0, 4).map(() => 'Some optional crawl checks were unavailable.'),
    factors: hasAuditedPages
      ? summary.auditRollup.factors.slice(0, 16).map((factor) => ({
        id: factor.id,
        name: clip(factor.name, 100),
        averageScore: round(factor.averageScore),
        count: factor.count,
      }))
      : [],
    pages,
    siteMap,
    attemptedHosts,
    error: hasAuditedPages ? null : 'No public pages could be audited in the Technical AEO sample.',
  }
}

/**
 * A bounded sample that reached its OWN ceiling is complete, not partial.
 *
 * `summary.complete` means "the crawler saw the whole site", which this sample
 * is designed never to do: `maxPages` is 5, so any real site stops at
 * `max-pages` and every check reported `partial`. That marked the whole record
 * partial and painted an amber "Partial result — Only completed checks are
 * included below. Failed checks are shown separately." over a run where
 * nothing failed. A caution banner on 100% of results is not a caution.
 *
 * Every `max-*` reason names a limit configured in
 * `VAL_TOWN_SITE_HEALTH_LIMITS`, so hitting one is the sample working. Anything
 * else — today only `root-host-redirect`, which means the crawl never reached
 * the host that was asked for — is a genuinely degraded outcome and stays
 * partial. The reason itself is reported either way, under "Sample scope".
 */
function isCompleteBoundedSample(terminationReason: string | null | undefined): boolean {
  return !terminationReason || terminationReason.startsWith('max-')
}

function toPage(page: CrawlPageObservation): SiteHealthPageSample {
  const audit = page.audit
  return {
    url: clip(page.finalUrl ?? page.requestedUrl, 2_048),
    status: audit ? 'success' : 'error',
    score: audit ? round(audit.overallScore) : null,
    depth: page.depth,
    indexability: page.indexability?.state ?? null,
    factors: audit
      ? audit.factors.slice(0, 16).map((factor) => ({
        id: factor.id,
        name: clip(factor.name, 100),
        score: round(factor.score),
        applicable: factor.applicable ?? null,
        findings: factor.findings.slice(0, 3).map((finding) => ({
          code: clip(finding.code, 160),
          message: clip(finding.message, 500),
        })),
        recommendations: factor.recommendations.slice(0, 3).map((recommendation) => clip(recommendation, 500)),
      } satisfies FactorSample))
      : [],
    criticalDefects: audit
      ? audit.criticalDefects.slice(0, 8).map((defect) => ({
        id: defect.id,
        severity: defect.severity,
        detail: clip(defect.detail, 500),
        recommendation: clip(defect.recommendation, 500),
      }))
      : [],
    error: audit ? null : 'This page could not be audited.',
  }
}

function sortWorstFirst(left: SiteHealthPageSample, right: SiteHealthPageSample): number {
  if (left.score == null && right.score != null) return -1
  if (left.score != null && right.score == null) return 1
  return (left.score ?? 0) - (right.score ?? 0) || left.url.localeCompare(right.url)
}

function failedSample(domain: string, attemptedHosts: string[], error: string): SiteHealthSample {
  return {
    schemaVersion: '1.0',
    label: '5-page Technical AEO sample',
    domain,
    rootUrl: `https://${domain}/`,
    finalRootUrl: null,
    status: 'error',
    score: null,
    pagesDiscovered: 0,
    pagesFetched: 0,
    pagesObserved: 0,
    elapsedMs: 0,
    terminationReason: null,
    warnings: [],
    factors: [],
    pages: [],
    siteMap: null,
    attemptedHosts,
    error,
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'The Technical AEO sample timed out.'
  }
  return 'The Technical AEO sample could not complete.'
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
