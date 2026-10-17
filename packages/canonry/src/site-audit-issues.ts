import { createHash } from 'node:crypto'
import type { CrawlPageObservation, SiteIssue } from '@canonry/aeo-audit'
import type { SiteCrawlIssueEvidence } from '@canonry/canonry-contracts'

const GROUP_IDENTITY_VERSION = 'duplicate-metadata-v1'

interface MetadataObservation {
  state: CrawlPageObservation['state']
  indexability: Pick<CrawlPageObservation['indexability'], 'state'>
  finalUrl: string | null
  audit: { metadata?: Pick<NonNullable<CrawlPageObservation['audit']>['metadata'], 'pageTitle' | 'metaDescription'> } | null
}

/** Preserve observed groups without treating a legacy omission as a measured zero. */
export function buildSiteCrawlIssueEvidence(
  siteIssues: readonly SiteIssue[] | undefined,
  pages: Iterable<MetadataObservation>,
): SiteCrawlIssueEvidence | null {
  if (siteIssues === undefined) return null
  const metadataByUrl = new Map<string, NonNullable<MetadataObservation['audit']>['metadata']>()
  if (siteIssues.length > 0) {
    for (const page of pages) {
      if (page.state === 'html' && page.indexability.state === 'indexable' && page.finalUrl && page.audit) {
        metadataByUrl.set(page.finalUrl, page.audit.metadata)
      }
    }
  }
  const groups = siteIssues.map((issue) => {
    const affectedUrls = [...new Set(issue.affectedUrls)].sort()
    const field = issue.code === 'site.duplicate-title' ? 'pageTitle'
      : issue.code === 'site.duplicate-meta-description' ? 'metaDescription' : null
    const values = field ? affectedUrls.map((url) => metadataByUrl.get(url)?.[field]?.trim()) : []
    const value = values[0]
    // Messages contain a count and only the first 120 characters. Neither the
    // prose nor changing URL membership can identify a continuing group.
    const key = value && values.every((candidate) => candidate === value)
      ? `site-issue:${createHash('sha256').update(JSON.stringify([GROUP_IDENTITY_VERSION, issue.code, value])).digest('hex')}`
      : null
    return { key, code: issue.code, message: issue.message, affectedUrls }
  })
  groups.sort((left, right) => left.code.localeCompare(right.code)
    || (left.key ?? '').localeCompare(right.key ?? '')
    || JSON.stringify(left.affectedUrls).localeCompare(JSON.stringify(right.affectedUrls)))
  return { schemaVersion: '1.0', groupIdentityVersion: GROUP_IDENTITY_VERSION, siteIssues: groups }
}
