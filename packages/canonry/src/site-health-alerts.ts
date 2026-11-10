import crypto from 'node:crypto'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import { siteCrawlPages, siteCrawlSnapshots, siteHealthNotifyState } from '@canonry/canonry-db'
import { compareText, type SiteHealthIssueAlert } from '@canonry/canonry-contracts'

/**
 * Short labels for the audit engine's critical page defects, as an alert names
 * them. An id the engine adds later shows as itself until it gets a label here.
 */
const ISSUE_TITLES: Record<string, string> = {
  'missing-h1': 'Missing H1',
  'multiple-h1': 'Multiple H1 tags',
  'missing-title': 'Missing title',
  'names-another-entity': 'Names another property',
}

const PAGE_BATCH = 500
const MAX_EXAMPLES = 5

/** The critical page problems one audit found. */
export interface SiteHealthScan {
  /** Whether the scan reached every page it found. */
  complete: boolean
  /** Defect id, then each affected page by key. */
  pagesByCode: Map<string, Map<string, string>>
  keys: Set<string>
}

/** One problem on one page: the defect id and a short hash of the page URL. */
export function siteHealthProblemKey(code: string, url: string): string {
  return `${code}|${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}`
}

/**
 * The critical page defects stored for an audit run's newest attempt, or null
 * when that attempt stored no page details. Warnings (a missing meta
 * description) are left out: the alert is for problems someone should fix now.
 */
export function readSiteHealthScan(db: DatabaseClient, projectId: string, runId: string): SiteHealthScan | null {
  const snapshot = db.select().from(siteCrawlSnapshots)
    .where(and(eq(siteCrawlSnapshots.projectId, projectId), eq(siteCrawlSnapshots.runId, runId)))
    .orderBy(desc(siteCrawlSnapshots.updatedAt))
    .limit(1)
    .get()
  if (!snapshot?.detailsAvailable || !snapshot.attemptId) return null
  const scope = and(
    eq(siteCrawlPages.projectId, projectId),
    eq(siteCrawlPages.runId, runId),
    eq(siteCrawlPages.attemptId, snapshot.attemptId),
  )
  const pagesByCode = new Map<string, Map<string, string>>()
  const keys = new Set<string>()
  let after: string | undefined
  for (;;) {
    const pages = db.select({ nodeKey: siteCrawlPages.nodeKey, url: siteCrawlPages.url, auditFields: siteCrawlPages.auditFields })
      .from(siteCrawlPages)
      .where(after === undefined ? scope : and(scope, gt(siteCrawlPages.nodeKey, after)))
      .orderBy(asc(siteCrawlPages.nodeKey))
      .limit(PAGE_BATCH)
      .all()
    for (const page of pages) {
      const defects = page.auditFields.criticalDefects
      for (const defect of Array.isArray(defects) ? defects : []) {
        if (!defect || typeof defect !== 'object') continue
        const { id, severity } = defect as { id?: unknown; severity?: unknown }
        if (typeof id !== 'string' || id === '' || severity !== 'critical') continue
        const key = siteHealthProblemKey(id, page.url)
        keys.add(key)
        let pagesForCode = pagesByCode.get(id)
        if (!pagesForCode) {
          pagesForCode = new Map()
          pagesByCode.set(id, pagesForCode)
        }
        pagesForCode.set(key, page.url)
      }
    }
    if (pages.length < PAGE_BATCH) break
    after = pages.at(-1)!.nodeKey
  }
  return { complete: snapshot.complete, pagesByCode, keys }
}

/** Each problem with at least one page not yet reported, most new pages first. */
export function newSiteHealthIssues(scan: SiteHealthScan, reported: ReadonlySet<string>): SiteHealthIssueAlert[] {
  const issues: SiteHealthIssueAlert[] = []
  for (const [code, pages] of scan.pagesByCode) {
    const fresh = [...pages].filter(([key]) => !reported.has(key)).map(([, url]) => url).sort(compareText)
    if (fresh.length === 0) continue
    issues.push({
      code,
      title: ISSUE_TITLES[code] ?? code,
      severity: 'critical',
      affectedPages: pages.size,
      newPages: fresh.length,
      examples: fresh.slice(0, MAX_EXAMPLES),
    })
  }
  return issues.sort((a, b) => b.newPages - a.newPages || compareText(a.code, b.code))
}

/**
 * What the next alert compares against. A complete scan replaces the set, so a
 * fixed problem is reported again if it comes back; a partial scan may have
 * missed pages, so it only adds.
 */
export function settledSiteHealthKeys(scan: SiteHealthScan, reported: ReadonlySet<string>): string[] {
  return [...(scan.complete ? scan.keys : new Set([...reported, ...scan.keys]))].sort(compareText)
}

export function readSiteHealthNotifyState(db: DatabaseClient, projectId: string) {
  return db.select().from(siteHealthNotifyState).where(eq(siteHealthNotifyState.projectId, projectId)).get() ?? null
}

export function writeSiteHealthNotifyState(db: DatabaseClient, input: {
  projectId: string
  runId: string
  reportedKeys: string[]
  updatedAt: string
  notifiedAt: string | null
}): void {
  const values = { reportedKeys: input.reportedKeys, runId: input.runId, updatedAt: input.updatedAt, notifiedAt: input.notifiedAt }
  db.insert(siteHealthNotifyState).values({ projectId: input.projectId, ...values })
    .onConflictDoUpdate({ target: siteHealthNotifyState.projectId, set: values })
    .run()
}
