import { createHash } from 'node:crypto'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { siteCrawlPages, type DatabaseClient, type siteCrawlSnapshots } from '@canonry/canonry-db'
import {
  notFound, siteAuditIssueListQuerySchema, siteCrawlAuditFindingSchema,
  siteCrawlIssueEvidenceSchema, siteCrawlCriticalDefectSchema, validationError, SITE_AUDIT_ISSUES_DEFAULT_LIMIT,
  type RunStatus, type SiteAuditIssueDto, type SiteAuditIssueListQuery,
  type SiteAuditIssuePageDto, type SiteAuditIssuePagesResponseDto,
  type SiteAuditIssuesResponseDto, type SiteAuditRunSelectionDto,
} from '@canonry/canonry-contracts'

type Snapshot = typeof siteCrawlSnapshots.$inferSelect
type Provenance = Omit<SiteAuditIssuesResponseDto, 'issues'>
const ADVISORY_CODES = new Set([
  'entity-consistency.title.short', 'site.duplicate-title', 'site.duplicate-meta-description',
])
const DISPOSITION_ORDER = { actionable: 0, advisory: 1, unverified: 2, informational: 3 }
const MAX_EVIDENCE_BYTES = 128 * 1024 * 1024
const MAX_GROUPS = 4096
const MAX_RESPONSE_BYTES = 16 * 1024

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function clip(message: string): { message: string; messageTruncated: boolean } {
  return { message: message.slice(0, 400), messageTruncated: message.length > 400 }
}

/** HTTP alone converts the scalar numeric limit; repeated, fractional and unknown inputs fail. */
export function parseSiteAuditIssueQuery(query: Record<string, unknown>): SiteAuditIssueListQuery {
  const limit = query.limit
  const parsed = siteAuditIssueListQuerySchema.safeParse({ ...query,
    ...(limit === undefined ? {} : { limit: typeof limit === 'string' && limit.trim() !== '' ? Number(limit) : limit }),
  })
  if (!parsed.success) throw validationError(parsed.error.issues.map(issue => issue.message).join('; '))
  return parsed.data
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const value = record(decoded)
    if (!value || value.v !== 1 || !Number.isSafeInteger(value.offset) || Number(value.offset) < 1
      || typeof value.check !== 'string' || Object.keys(value).length !== 3) throw new Error('cursor')
    if (Buffer.from(JSON.stringify(value)).toString('base64url') !== cursor) throw new Error('cursor')
    return Number(value.offset)
  } catch {
    throw validationError('Invalid stored audit issue cursor')
  }
}

function encodeCursor(basis: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset, check: digest([basis, offset]) })).toString('base64url')
}

function pageEvidence(nodeKey: string | null, url: string, message: string, factor?: Record<string, unknown>): SiteAuditIssuePageDto {
  const recommendations = Array.isArray(factor?.recommendations)
    ? factor.recommendations.filter((value): value is string => typeof value === 'string') : []
  return {
    nodeKey, url, ...clip(message), recommendations: recommendations.slice(0, 3).map(value => value.slice(0, 400)),
    recommendationsScope: factor ? 'factor' : 'none',
    recommendationsTruncated: recommendations.length > 3 || recommendations.some(value => value.length > 400),
  }
}

/** A stored-only read. Batch scans retain counts and three examples, never a site's full page payloads. */
export function readSiteAuditIssues(input: {
  db: DatabaseClient
  project: { id: string; name: string }
  target?: { snapshot: Snapshot; runStatus: string; runSelection: SiteAuditRunSelectionDto }
  query: SiteAuditIssueListQuery
  issueId?: string
}): SiteAuditIssuesResponseDto | SiteAuditIssuePagesResponseDto {
  const { db, project, target, query, issueId } = input
  const limit = query.limit ?? SITE_AUDIT_ISSUES_DEFAULT_LIMIT
  const offset = cursorOffset(query.cursor)
  const coverage: Provenance['coverage'] = {
    pageFindings: 'unavailable', crossPage: 'unavailable', auditedPages: 0,
    pagesWithFindingEvidence: 0, pagesWithoutFindingEvidence: 0, omittedFindings: 0,
  }
  const provenance: Provenance = {
    project: project.name, runId: target?.snapshot.runId ?? null,
    attemptId: target?.snapshot.attemptId ?? null, auditedAt: target?.snapshot.createdAt ?? null,
    runStatus: target?.runStatus as RunStatus | undefined ?? null,
    complete: target?.snapshot.complete ?? false, termination: target?.snapshot.termination ?? null,
    ...(target ? { runSelection: target.runSelection } : {}),
    state: target ? 'unavailable' : 'no-crawl', coverage, total: null, nextCursor: null,
  }
  if (!target) {
    if (query.cursor) throw validationError('Stored audit issue cursor no longer identifies a crawl')
    const response = issueId === undefined ? { ...provenance, issues: [] } : { ...provenance, issueId, pages: [] }
    if (Buffer.byteLength(JSON.stringify(response, null, 2)) > MAX_RESPONSE_BYTES) throw validationError('Stored audit issue exceeds the 16 KiB response budget')
    return response
  }
  const snapshot = target.snapshot
  const crossJson = JSON.stringify(snapshot.issueEvidence)
  const crossBytes = Buffer.byteLength(crossJson)
  if (crossBytes > MAX_EVIDENCE_BYTES) throw validationError('Stored audit exceeds the 128 MiB issue-evidence read budget')
  const groups = new Map<string, SiteAuditIssueDto>()
  const members: SiteAuditIssuePageDto[] = []
  let selectedMembers = 0
  const evidenceHash = createHash('sha256').update(JSON.stringify([
    project.id, snapshot.runId, snapshot.attemptId, snapshot.createdAt, snapshot.updatedAt,
    snapshot.complete, snapshot.termination, snapshot.detailsAvailable,
    issueId ?? null,
  ])).update(crossJson)
  const addMember = (group: SiteAuditIssueDto, page: SiteAuditIssuePageDto) => {
    group.affectedPages += 1
    if (group.examples.length < 3) group.examples.push(page)
    else group.examplesTruncated = true
    if (group.id === issueId) {
      if (selectedMembers >= offset && members.length < limit + 1) members.push(page)
      selectedMembers += 1
    }
  }
  const addGroup = (group: SiteAuditIssueDto): SiteAuditIssueDto => {
    const existing = groups.get(group.id)
    if (existing) return existing
    if (groups.size >= MAX_GROUPS) throw validationError('Stored audit exceeds the 4096 issue-group read budget')
    groups.set(group.id, group)
    return group
  }
  const cross = siteCrawlIssueEvidenceSchema.safeParse(snapshot.issueEvidence)
  const mirroredCodes = new Set<string>()
  if (cross.success) {
    coverage.crossPage = 'available'
    for (const [index, issue] of cross.data.siteIssues.entries()) {
      // One persisted cross-page group is stronger evidence than its mirrored page annotations.
      mirroredCodes.add(issue.code)
      const id = issue.key ?? `run-issue:${digest([snapshot.runId, snapshot.attemptId, index, issue])}`
      const group = addGroup({
        id, stableIdentity: issue.key !== null, code: issue.code, source: 'cross-page', factorId: null, severity: null,
        findingType: 'info', disposition: ADVISORY_CODES.has(issue.code) ? 'advisory' : 'informational',
        ...clip(issue.message), affectedPages: 0, examples: [], examplesTruncated: false,
      })
      for (const url of [...new Set(issue.affectedUrls)].sort()) addMember(group, pageEvidence(null, url, issue.message))
    }
  }
  if (snapshot.detailsAvailable && snapshot.attemptId) {
    const scope = and(eq(siteCrawlPages.projectId, project.id), eq(siteCrawlPages.runId, snapshot.runId),
      eq(siteCrawlPages.attemptId, snapshot.attemptId))
    const size = db.select({ bytes: sql<number>`coalesce(sum(length(cast(${siteCrawlPages.auditFields} as blob)) + length(cast(${siteCrawlPages.url} as blob))), 0)` })
      .from(siteCrawlPages).where(scope).get()?.bytes ?? 0
    if (size + crossBytes > MAX_EVIDENCE_BYTES) {
      throw validationError('Stored audit exceeds the 128 MiB issue-evidence read budget')
    }
    let after: string | undefined
    while (true) {
      const pages = db.select({ nodeKey: siteCrawlPages.nodeKey, url: siteCrawlPages.url,
        auditScore: siteCrawlPages.auditScore, auditFields: siteCrawlPages.auditFields })
        .from(siteCrawlPages).where(and(scope, after === undefined ? undefined : gt(siteCrawlPages.nodeKey, after)))
        .orderBy(asc(siteCrawlPages.nodeKey)).limit(200).all()
      for (const page of pages) {
        evidenceHash.update(JSON.stringify(page))
        const fields = record(page.auditFields)
        if (page.auditScore !== null || fields?.schemaVersion === '1.0') coverage.auditedPages += 1
        if (fields?.schemaVersion !== '1.0') {
          if (page.auditScore !== null) coverage.pagesWithoutFindingEvidence += 1
          continue
        }
        let pageComplete = Array.isArray(fields.factors) && Array.isArray(fields.criticalDefects)
        if (!Array.isArray(fields.factors)) coverage.omittedFindings += 1
        if (!Array.isArray(fields.criticalDefects)) coverage.omittedFindings += 1
        const seen = new Set<string>()
        for (const rawFactor of Array.isArray(fields.factors) ? fields.factors : []) {
          const factor = record(rawFactor)
          if (!factor || typeof factor.id !== 'string' || !factor.id || !Array.isArray(factor.findings)) {
            pageComplete = false
            coverage.omittedFindings += 1
            continue
          }
          for (const rawFinding of factor.findings) {
            const parsed = siteCrawlAuditFindingSchema.safeParse(rawFinding)
            if (!parsed.success) { coverage.omittedFindings += 1; pageComplete = false; continue }
            const finding = parsed.data
            // The auditor retains findings for inapplicable factors; they are
            // not repair targets. Missing legacy applicability remains usable.
            if (factor.applicable === false) continue
            if (finding.type === 'found' || finding.type === 'info' && mirroredCodes.has(finding.code)) continue
            const id = `page-issue:${digest(['page-finding-v1', factor.id, finding.code, finding.type])}`
            if (seen.has(id)) continue
            seen.add(id)
            const disposition = finding.type === 'missing' ? 'actionable'
              : finding.type === 'timeout' || finding.type === 'unreachable' ? 'unverified'
                : ADVISORY_CODES.has(finding.code) ? 'advisory' : 'informational'
            const group = addGroup({ id, stableIdentity: true, code: finding.code, source: 'page-finding', severity: null,
              factorId: factor.id, findingType: finding.type, disposition, ...clip(finding.message),
              affectedPages: 0, examples: [], examplesTruncated: false })
            addMember(group, pageEvidence(page.nodeKey, page.url, finding.message, factor))
          }
        }
        for (const rawDefect of Array.isArray(fields.criticalDefects) ? fields.criticalDefects : []) {
          const parsed = siteCrawlCriticalDefectSchema.safeParse(rawDefect)
          if (!parsed.success) { coverage.omittedFindings += 1; pageComplete = false; continue }
          const defect = parsed.data
          const id = `critical-issue:${digest(['critical-defect-v1', defect.id])}`
          if (seen.has(id)) continue
          seen.add(id)
          const group = addGroup({ id, stableIdentity: true, code: defect.id, source: 'critical-defect',
            factorId: null, severity: defect.severity, findingType: 'missing', disposition: 'actionable',
            ...clip(defect.detail), affectedPages: 0, examples: [], examplesTruncated: false })
          if (defect.severity === 'critical') group.severity = 'critical'
          addMember(group, { ...pageEvidence(page.nodeKey, page.url, defect.detail),
            recommendations: [defect.recommendation.slice(0, 400)], recommendationsScope: 'issue',
            recommendationsTruncated: defect.recommendation.length > 400 })
        }
        if (pageComplete) coverage.pagesWithFindingEvidence += 1
        else coverage.pagesWithoutFindingEvidence += 1
      }
      if (pages.length < 200) break
      after = pages.at(-1)!.nodeKey
    }
    if (coverage.pagesWithFindingEvidence > 0 || groups.size > 0 && coverage.omittedFindings > 0) {
      coverage.pageFindings = coverage.pagesWithoutFindingEvidence > 0 || coverage.omittedFindings > 0 ? 'partial' : 'available'
    }
  }
  const usable = coverage.pageFindings !== 'unavailable' || coverage.crossPage === 'available' || groups.size > 0
  provenance.state = !usable ? 'unavailable'
    : snapshot.complete && coverage.pageFindings === 'available' && coverage.crossPage === 'available'
      ? 'available' : 'partial'
  const basis = evidenceHash.digest('hex')
  if (query.cursor && query.cursor !== encodeCursor(basis, offset)) {
    throw validationError('Stored audit issue cursor does not match this project, run, attempt, issue, or retained evidence')
  }
  const issues = [...groups.values()].sort((a, b) => DISPOSITION_ORDER[a.disposition] - DISPOSITION_ORDER[b.disposition]
    || (a.severity === 'critical' ? 0 : a.severity === 'warning' ? 1 : 2) - (b.severity === 'critical' ? 0 : b.severity === 'warning' ? 1 : 2)
    || b.affectedPages - a.affectedPages || a.id.localeCompare(b.id))
  if (issueId !== undefined && !groups.has(issueId) && usable) throw notFound('Stored audit issue', issueId)
  provenance.total = usable ? issueId === undefined ? issues.length : selectedMembers : null
  if (offset > 0 && (provenance.total === null || offset >= provenance.total)) throw validationError('Stored audit issue cursor is out of range')
  const candidates = issueId === undefined ? issues.slice(offset, offset + limit) : members.slice(0, limit)
  const responseForLength = (length: number): SiteAuditIssuesResponseDto | SiteAuditIssuePagesResponseDto => {
    const nextCursor = provenance.total !== null && offset + length < provenance.total
      ? encodeCursor(basis, offset + length) : null
    return issueId === undefined ? { ...provenance, nextCursor, issues: issues.slice(offset, offset + length) }
      : { ...provenance, nextCursor, issueId, pages: members.slice(0, length) }
  }
  let length = candidates.length
  while (length > 0 && Buffer.byteLength(JSON.stringify(responseForLength(length), null, 2)) > MAX_RESPONSE_BYTES) length -= 1
  // A normal group can exceed the byte budget with three multi-byte examples.
  // Keep at least one repair target; the member endpoint retains every URL.
  if (length === 0 && candidates.length && issueId === undefined) {
    const first = issues[offset]!
    while (first.examples.length > 1 && Buffer.byteLength(JSON.stringify(responseForLength(1), null, 2)) > MAX_RESPONSE_BYTES) {
      first.examples.pop()
      first.examplesTruncated = true
    }
    if (Buffer.byteLength(JSON.stringify(responseForLength(1), null, 2)) <= MAX_RESPONSE_BYTES) length = 1
  }
  const response = responseForLength(length)
  if (candidates.length && length === 0 || Buffer.byteLength(JSON.stringify(response, null, 2)) > MAX_RESPONSE_BYTES) {
    throw validationError('Stored audit issue exceeds the 16 KiB response budget')
  }
  return response
}
