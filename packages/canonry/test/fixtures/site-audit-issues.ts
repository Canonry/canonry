import type { SiteAuditIssuePagesResponseDto, SiteAuditIssuesResponseDto } from '@ainyc/canonry-contracts'

export const storedIssuePages: SiteAuditIssuePagesResponseDto = {
  project: 'sample-store',
  runId: 'scan-2026-10-10',
  attemptId: 'attempt-sample',
  auditedAt: '2026-10-10T14:00:00.000Z',
  runStatus: 'partial',
  complete: false,
  termination: 'max-pages',
  state: 'partial',
  coverage: {
    pageFindings: 'partial', crossPage: 'available', auditedPages: 4,
    pagesWithFindingEvidence: 3, pagesWithoutFindingEvidence: 1, omittedFindings: 2,
  },
  total: 2,
  nextCursor: 'opaque-pages-next',
  issueId: 'duplicate-title-sample',
  pages: [{
    nodeKey: 'page:alpha', url: 'https://sample.example/alpha',
    message: 'This title also appears on another audited page.', messageTruncated: false,
    recommendations: ['Review titles and descriptions for this page.'],
    recommendationsScope: 'factor', recommendationsTruncated: true,
  }],
}

const { issueId, pages, ...context } = storedIssuePages
export const storedIssues: SiteAuditIssuesResponseDto = {
  ...context,
  total: 4,
  nextCursor: 'opaque-issues-next',
  issues: [{
    id: issueId, stableIdentity: true, code: 'title.duplicate', source: 'cross-page',
    factorId: null, findingType: 'info', disposition: 'advisory', severity: null,
    message: 'Two audited pages share the same title.', messageTruncated: false,
    affectedPages: 2, examples: pages, examplesTruncated: true,
  }],
}

export const unavailableIssues: SiteAuditIssuesResponseDto = {
  ...storedIssues,
  complete: true,
  termination: 'complete',
  runStatus: 'completed',
  state: 'unavailable',
  coverage: {
    pageFindings: 'unavailable', crossPage: 'unavailable', auditedPages: 4,
    pagesWithFindingEvidence: 0, pagesWithoutFindingEvidence: 4, omittedFindings: 0,
  },
  total: null, nextCursor: null, issues: [],
}
