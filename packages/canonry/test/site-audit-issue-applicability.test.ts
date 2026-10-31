import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { auditHtmlPage } from '@canonry/aeo-audit'
import { apiRoutes } from '@canonry/canonry-api-routes'
import {
  factorStatusFromScore, siteAuditIssuePagesResponseSchema, siteAuditIssuesResponseSchema,
  type SiteAuditIssueDto,
} from '@canonry/canonry-contracts'
import {
  createClient, migrate, projects, runs, siteCrawlAttempts, siteCrawlPages, siteCrawlSnapshots,
} from '@canonry/canonry-db'

describe('stored audit issue applicability', () => {
  it('excludes explicitly inapplicable findings while preserving applicable, legacy and independent defects', async () => {
    const db = createClient(':memory:')
    const app = Fastify()
    try {
      migrate(db)
      app.register(apiRoutes, { db, skipAuth: true })
      const now = '2026-10-12T12:00:00.000Z'
      const projectId = randomUUID()
      const runId = randomUUID()
      const attemptId = randomUUID()
      db.insert(projects).values({
        id: projectId, name: 'applicability', displayName: 'Applicability', canonicalDomain: 'example.test',
        country: 'US', language: 'en', providers: [], locations: [], createdAt: now, updatedAt: now,
      }).run()
      db.insert(runs).values({
        id: runId, projectId, kind: 'site-audit', status: 'completed', trigger: 'manual',
        createdAt: now, finishedAt: now,
      }).run()
      db.insert(siteCrawlAttempts).values({
        id: attemptId, projectId, runId, attemptNumber: 1, state: 'completed',
        startedAt: now, finishedAt: now, createdAt: now, updatedAt: now,
      }).run()
      db.insert(siteCrawlSnapshots).values({
        id: randomUUID(), projectId, runId, attemptId, rootUrl: 'https://example.test/',
        complete: true, termination: 'completed', detailsAvailable: true,
        issueEvidence: { schemaVersion: '1.0', groupIdentityVersion: 'duplicate-metadata-v1', siteIssues: [] },
        createdAt: now, updatedAt: now,
      }).run()

      const pages = [
        { nodeKey: 'pricing', applicability: 'recorded' },
        { nodeKey: 'support', applicability: 'recorded' },
        { nodeKey: 'legacy-absent', applicability: 'absent' },
        { nodeKey: 'legacy-null', applicability: null },
      ] as const
      for (const page of pages) {
        const url = `https://example.test/${page.nodeKey}`
        // The published engine keeps missing FAQ/HowTo findings on pricing
        // pages, alongside an explicit declaration that these factors do not apply.
        const audit = await auditHtmlPage({
          inputUrl: url, finalUrl: url, headers: {}, redirectChain: [], auxiliary: {}, fetchTimeMs: 0,
          html: `<html><head><title>Product plans</title><meta name="description" content="Our product plans"></head>
            <body>${page.nodeKey === 'pricing' ? '' : '<h1>Product plans</h1>'}<p>Plans start at ten dollars per month.</p></body></html>`,
        }, { factors: ['faq-content', 'definition-blocks'] })
        expect(audit.factors.map(factor => ({ id: factor.id, applicable: factor.applicable }))).toEqual([
          { id: 'faq-content', applicable: page.nodeKey === 'support' },
          { id: 'definition-blocks', applicable: page.nodeKey === 'support' },
        ])
        const factors = audit.factors.map(factor => {
          const stored: Record<string, unknown> = { ...factor, status: factorStatusFromScore(factor.score) }
          // Older retained rows can omit applicability or record it as unknown.
          if (page.applicability === 'absent') delete stored.applicable
          else if (page.applicability === null) stored.applicable = null
          return stored
        })
        db.insert(siteCrawlPages).values({
          id: randomUUID(), projectId, runId, attemptId, nodeKey: page.nodeKey, url,
          path: `/${page.nodeKey}`, parentPath: '/', discoverySource: 'sitemap',
          fetchState: 'html', auditState: 'complete', auditScore: audit.overallScore,
          auditFields: { schemaVersion: '1.0', factors, criticalDefects: audit.criticalDefects },
          createdAt: now, updatedAt: now,
        }).run()
      }

      const issues: SiteAuditIssueDto[] = []
      let cursor: string | null = null
      do {
        const response = await app.inject({
          method: 'GET', url: '/api/v1/projects/applicability/technical-aeo/issues',
          query: { runId, limit: '100', ...(cursor ? { cursor } : {}) },
        })
        expect(response.statusCode).toBe(200)
        const result = siteAuditIssuesResponseSchema.parse(response.json())
        expect(result).toMatchObject({ state: 'available', coverage: {
          auditedPages: 4, pagesWithFindingEvidence: 4, pagesWithoutFindingEvidence: 0, omittedFindings: 0,
        } })
        issues.push(...result.issues)
        cursor = result.nextCursor
      } while (cursor)

      const missing = issues.filter(issue => issue.source === 'page-finding' && issue.findingType === 'missing')
      expect(missing.map(issue => issue.code).sort()).toEqual([
        'definition-blocks.headings.missing', 'definition-blocks.schema.missing',
        'faq-content.faqpage.missing', 'faq-content.headings.missing',
      ])
      for (const issue of issues.filter(issue => issue.source === 'page-finding')) {
        expect(issue.affectedPages).toBe(3)
        expect(issue.examples.map(page => page.nodeKey).sort()).toEqual(['legacy-absent', 'legacy-null', 'support'])
      }
      for (const issue of missing) {
        expect(issue.disposition).toBe('actionable')
        const response = await app.inject({
          method: 'GET', url: `/api/v1/projects/applicability/technical-aeo/issues/${issue.id}/pages`, query: { runId },
        })
        expect(response.statusCode).toBe(200)
        const result = siteAuditIssuePagesResponseSchema.parse(response.json())
        expect(result).toMatchObject({ total: 3, nextCursor: null })
        expect(result.pages.map(page => page.nodeKey)).toEqual(['legacy-absent', 'legacy-null', 'support'])
      }
      expect(issues.filter(issue => issue.source === 'critical-defect')).toMatchObject([{
        code: 'missing-h1', severity: 'critical', disposition: 'actionable', affectedPages: 1,
        examples: [{ nodeKey: 'pricing', url: 'https://example.test/pricing' }],
      }])
    } finally {
      await app.close()
      db.$client.close()
    }
  })
})
