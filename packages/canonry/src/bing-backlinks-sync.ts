import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { backlinkDomains, backlinkSummaries, projects, runs } from '@ainyc/canonry-db'
import { getLinkCounts, getUrlLinks, type BingInboundLink } from '@ainyc/canonry-integration-bing'
import { BacklinkSources, RunStatuses } from '@ainyc/canonry-contracts'
import { createLogger } from './logger.js'

const log = createLogger('BingBacklinkSync')

// Cap how many of the site's pages we fetch inbound links for. Each page is one
// or more Bing API calls (GetUrlLinks paginates), so this bounds the daily
// request budget for a deeply-linked site.
const DEFAULT_MAX_PAGES = 200

/**
 * Bing inbound links have no native window concept, so each sync is stamped
 * with a synthetic per-UTC-day window id (`bing-YYYY-MM-DD`). Re-syncing the
 * same day replaces that day's snapshot (the per-source UNIQUE); distinct days
 * accumulate, which is what powers the history chart and "latest" for Bing —
 * the same way Common Crawl release ids do.
 */
export function bingReleaseId(date: Date): string {
  return `bing-${date.toISOString().slice(0, 10)}`
}

function hostOf(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`)
    return url.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

export interface AggregatedLinkingDomain {
  linkingDomain: string
  numHosts: number
}

/**
 * Folds raw Bing inbound links into per-linking-domain rows. Aggregates at the
 * host level (normalized, www-stripped, lowercased), counting DISTINCT linking
 * pages per host as `numHosts` — the Bing analog of Common Crawl's host count
 * (a "referring pages" weight). Self-links (from the project's own domain or a
 * subdomain of it) are excluded — those are internal links, not backlinks.
 * Returned strongest-first, ties broken alphabetically for determinism.
 */
export function aggregateInboundLinksByDomain(
  links: BingInboundLink[],
  targetDomain: string,
): AggregatedLinkingDomain[] {
  const target = hostOf(targetDomain)
  const byHost = new Map<string, Set<string>>()
  for (const link of links) {
    const host = hostOf(link.Url)
    if (!host) continue
    if (target && (host === target || host.endsWith(`.${target}`))) continue
    let urls = byHost.get(host)
    if (!urls) {
      urls = new Set()
      byHost.set(host, urls)
    }
    urls.add(link.Url)
  }
  return [...byHost.entries()]
    .map(([linkingDomain, urls]) => ({ linkingDomain, numHosts: urls.size }))
    .sort((a, b) => b.numHosts - a.numHosts || a.linkingDomain.localeCompare(b.linkingDomain))
}

export interface BacklinkSummaryMetrics {
  totalLinkingDomains: number
  totalHosts: number
  top10HostsShare: string
}

export function computeBingSummary(rows: AggregatedLinkingDomain[]): BacklinkSummaryMetrics {
  if (rows.length === 0) {
    return { totalLinkingDomains: 0, totalHosts: 0, top10HostsShare: '0' }
  }
  const sorted = [...rows].sort((a, b) => b.numHosts - a.numHosts)
  const totalHosts = sorted.reduce((acc, r) => acc + r.numHosts, 0)
  const top10Hosts = sorted.slice(0, 10).reduce((acc, r) => acc + r.numHosts, 0)
  const share = totalHosts > 0 ? top10Hosts / totalHosts : 0
  return {
    totalLinkingDomains: rows.length,
    totalHosts,
    top10HostsShare: share.toFixed(6),
  }
}

export interface BingBacklinkSyncDeps {
  getLinkCounts: typeof getLinkCounts
  getUrlLinks: typeof getUrlLinks
  now: () => Date
}

export interface BingBacklinkConnection {
  apiKey: string
  siteUrl?: string | null
}

export interface ExecuteBingBacklinkSyncOptions {
  /** Resolves the Bing connection (apiKey + selected siteUrl) for a domain. */
  resolveConnection: (domain: string) => BingBacklinkConnection | undefined
  deps?: Partial<BingBacklinkSyncDeps>
  /** Max site pages to pull inbound links for (most-linked first). */
  maxPages?: number
}

function defaultDeps(): BingBacklinkSyncDeps {
  return { getLinkCounts, getUrlLinks, now: () => new Date() }
}

/**
 * Per-project Bing inbound-links sync. Lists the site's pages with inbound
 * links (`GetLinkCounts`), pulls the actual linking URLs for each
 * (`GetUrlLinks`), folds them into per-domain rows, and writes
 * `source='bing-webmaster'` backlink rows + a summary for today's window. The
 * run row is owned by the caller; this updates its status running → completed
 * / failed.
 */
export async function executeBingBacklinkSync(
  db: DatabaseClient,
  runId: string,
  projectId: string,
  opts: ExecuteBingBacklinkSyncOptions,
): Promise<void> {
  const deps = { ...defaultDeps(), ...opts.deps }
  const startedAt = deps.now().toISOString()
  db.update(runs).set({ status: RunStatuses.running, startedAt }).where(eq(runs.id, runId)).run()

  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw new Error(`Project not found: ${projectId}`)

    const conn = opts.resolveConnection(project.canonicalDomain)
    if (!conn) throw new Error(`No Bing Webmaster connection for ${project.canonicalDomain}`)
    const siteUrl = conn.siteUrl
    if (!siteUrl) {
      throw new Error(`Bing connection for ${project.canonicalDomain} has no verified site selected`)
    }

    // 1. The site's pages that have inbound links, with per-page counts.
    const pages = await deps.getLinkCounts(conn.apiKey, siteUrl)
    const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES)
    const targetPages = [...pages].sort((a, b) => b.Count - a.Count).slice(0, maxPages)

    // 2. The actual external linking URLs for each page. A single page's fetch
    // failing (e.g. a transient Bing error on one URL) degrades the run to
    // `partial` and keeps the rest of the snapshot, rather than discarding every
    // page's links; an all-pages failure is escalated to a hard failure below.
    const allLinks: BingInboundLink[] = []
    let pageFailures = 0
    for (const page of targetPages) {
      try {
        const links = await deps.getUrlLinks(conn.apiKey, siteUrl, page.Url)
        allLinks.push(...links)
      } catch (err) {
        pageFailures++
        log.warn('bing-sync.page-failed', {
          runId,
          projectId,
          page: page.Url,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // Every attempted page failed — there's no trustworthy snapshot, so fail the
    // run instead of overwriting today's window with an empty result.
    if (targetPages.length > 0 && pageFailures === targetPages.length) {
      throw new Error(`All ${targetPages.length} Bing inbound-link page fetch(es) failed`)
    }

    // 3. Fold into per-linking-domain rows + a summary.
    const rows = aggregateInboundLinksByDomain(allLinks, project.canonicalDomain)
    const summary = computeBingSummary(rows)

    const queriedAt = deps.now().toISOString()
    const release = bingReleaseId(deps.now())
    const targetDomain = project.canonicalDomain
    const source = BacklinkSources['bing-webmaster']

    db.transaction((tx) => {
      tx.delete(backlinkDomains).where(and(
        eq(backlinkDomains.projectId, projectId),
        eq(backlinkDomains.source, source),
        eq(backlinkDomains.release, release),
      )).run()

      if (rows.length > 0) {
        tx.insert(backlinkDomains).values(rows.map((r) => ({
          id: crypto.randomUUID(),
          projectId,
          releaseSyncId: null,
          source,
          release,
          targetDomain,
          linkingDomain: r.linkingDomain,
          numHosts: r.numHosts,
          createdAt: queriedAt,
        }))).run()
      }

      tx.insert(backlinkSummaries).values({
        id: crypto.randomUUID(),
        projectId,
        releaseSyncId: null,
        source,
        release,
        targetDomain,
        totalLinkingDomains: summary.totalLinkingDomains,
        totalHosts: summary.totalHosts,
        top10HostsShare: summary.top10HostsShare,
        queriedAt,
        createdAt: queriedAt,
      }).onConflictDoUpdate({
        target: [backlinkSummaries.projectId, backlinkSummaries.source, backlinkSummaries.release],
        set: {
          targetDomain,
          totalLinkingDomains: summary.totalLinkingDomains,
          totalHosts: summary.totalHosts,
          top10HostsShare: summary.top10HostsShare,
          queriedAt,
        },
      }).run()
    })

    const finishedAt = deps.now().toISOString()
    const status = pageFailures > 0 ? RunStatuses.partial : RunStatuses.completed
    const error = pageFailures > 0
      ? `${pageFailures} of ${targetPages.length} inbound-link page fetches failed`
      : null
    db.update(runs).set({ status, error, finishedAt }).where(eq(runs.id, runId)).run()
    log.info('bing-sync.completed', { runId, projectId, release, rows: rows.length, status, pageFailures })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    const finishedAt = deps.now().toISOString()
    db.update(runs).set({ status: RunStatuses.failed, error: errorMsg, finishedAt }).where(eq(runs.id, runId)).run()
    log.error('bing-sync.failed', { runId, projectId, error: errorMsg })
    throw err
  }
}
