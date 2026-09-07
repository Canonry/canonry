import { describe, expect, it } from 'vitest'
import {
  SITE_AUDIT_DEFAULT_PAGE_LIMIT,
  SITE_AUDIT_MAX_EDGE_LIMIT,
  SITE_AUDIT_MAX_PAGE_LIMIT,
  deriveSiteHealthState,
  normalizeSiteAuditRunRequest,
  siteAuditRequestIdentity,
  siteAuditLivePageHealthSchema,
  siteAuditRunRequestSchema,
  siteAuditRunProgressSchema,
  siteCrawlDeadLinksResponseSchema,
  siteCrawlGraphResponseSchema,
  siteCrawlPageAuditSchema,
  siteCrawlSummarySchema,
  siteHealthScansResponseSchema,
  siteHealthStateSchema,
  SITE_HEALTH_SCANS_DEFAULT_LIMIT,
  SITE_HEALTH_SCANS_MAX_LIMIT,
} from '../src/technical-aeo.js'

describe('Technical AEO crawl contracts', () => {
  it('defaults the page budget but leaves the edge budget unset for the engine to derive', () => {
    expect(SITE_AUDIT_DEFAULT_PAGE_LIMIT).toBe(1_000)
    expect(SITE_AUDIT_MAX_PAGE_LIMIT).toBe(50_000)
    expect(SITE_AUDIT_MAX_EDGE_LIMIT).toBe(1_000_000)
    // A flat edge default here caps BELOW the engine's own derivation
    // (pages x 50, floored at 100,000) on any crawl over 2,000 pages, so an
    // omitted maxEdges must stay null all the way to the executor.
    expect(normalizeSiteAuditRunRequest({})).toEqual({
      schemaVersion: 2,
      sitemapUrl: null,
      maxPages: 1_000,
      maxEdges: null,
      maxDepth: null,
      checkDeadLinks: false,
    })
    expect(normalizeSiteAuditRunRequest({ maxEdges: 435_000 })).toMatchObject({ maxEdges: 435_000 })
  })

  it('models exact stored run progress without inventing a completion percentage', () => {
    expect(siteAuditRunProgressSchema.parse({
      project: 'example',
      runId: 'run-1',
      status: 'running',
      phase: 'checking',
      attempt: {
        id: 'attempt-1', state: 'running',
        pagesDiscovered: 42, pagesFetched: 17, pagesEligible: 12, pagesErrored: 1, edgesDiscovered: 88,
        lastUpdatedAt: '2026-08-09T12:00:00.000Z', startedAt: '2026-08-09T11:59:00.000Z', finishedAt: null, error: null,
      },
      layout: { state: 'pending', layoutVersion: null, failureCode: null, updatedAt: null },
      error: null,
    })).toMatchObject({ phase: 'checking', layout: { state: 'pending' } })
  })

  it('models a bounded, provisional Page Health preview separately from final findings', () => {
    const preview = siteAuditLivePageHealthSchema.parse({
      project: 'example',
      runId: 'run-1',
      status: 'running',
      state: 'collecting',
      attemptId: 'attempt-1',
      pagesAudited: 42,
      updatedAt: '2026-08-11T12:00:00.000Z',
      examples: [{
        nodeKey: 'guide',
        url: 'https://example.com/guide',
        auditScore: 42,
        checksNeedingAttention: 2,
      }],
    })

    expect(preview).toMatchObject({ state: 'collecting', pagesAudited: 42 })
    expect(siteAuditLivePageHealthSchema.safeParse({
      ...preview,
      examples: Array.from({ length: 13 }, () => preview.examples[0]),
    }).success).toBe(false)
  })

  it('defaults dead-link checking off while retaining the legacy sitemapUrl and limit aliases', () => {
    expect(siteAuditRunRequestSchema.parse({ sitemapUrl: 'https://example.com/sitemap.xml', limit: 20 })).toMatchObject({
      sitemapUrl: 'https://example.com/sitemap.xml',
      limit: 20,
      checkDeadLinks: false,
    })
    expect(siteAuditRunRequestSchema.safeParse({ maxPages: 50_000, maxEdges: 1_000_000 }).success).toBe(true)
    expect(siteAuditRunRequestSchema.safeParse({ maxPages: 50_001 }).success).toBe(false)
    expect(siteAuditRunRequestSchema.safeParse({ maxEdges: 1_000_001 }).success).toBe(false)
  })

  it('normalizes aliases and includes every production-changing option in request identity', () => {
    const legacy = normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ limit: 20 }))
    const current = normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxPages: 20, checkDeadLinks: false }))
    expect(siteAuditRequestIdentity(legacy)).toBe(siteAuditRequestIdentity(current))

    for (const changed of [
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ sitemapUrl: 'https://example.com/custom.xml' })),
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxPages: 20 })),
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxEdges: 20 })),
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxDepth: 2 })),
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ checkDeadLinks: true })),
    ]) {
      expect(siteAuditRequestIdentity(changed)).not.toBe(siteAuditRequestIdentity(normalizeSiteAuditRunRequest({})))
    }
  })

  it('dedups two unset edge budgets against each other but never against an explicit number', () => {
    const unset = siteAuditRequestIdentity(normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({})))
    const alsoUnset = siteAuditRequestIdentity(
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxPages: 1_000 })),
    )
    // Unset is one stable request, so two unattended crawls still consolidate.
    expect(unset).toBe(alsoUnset)

    // "Let the engine decide" is a different crawl from "cap me at 100,000",
    // which is exactly the collision the old flat default created.
    const explicitOldDefault = siteAuditRequestIdentity(
      normalizeSiteAuditRunRequest(siteAuditRunRequestSchema.parse({ maxEdges: 100_000 })),
    )
    expect(explicitOldDefault).not.toBe(unset)

    // The identity is positional JSON, so an unset budget must serialize as a
    // readable null rather than collapsing out of the array.
    expect(JSON.parse(unset)[3]).toBeNull()
    expect(JSON.parse(explicitOldDefault)[3]).toBe(100_000)
    // A version-1 key (omitted maxEdges stored as 100000) can never be read as
    // a version-2 request, so a pre-upgrade in-flight run refuses instead of
    // silently absorbing a crawl with different budget semantics.
    expect(JSON.parse(unset)[0]).toBe(2)
  })

  it('makes no crawl data distinct from a zero-count crawl and from disabled dead-link checks', () => {
    expect(siteCrawlSummarySchema.parse({
      project: 'example', hasCrawlData: false, legacyAuditAvailable: true, runId: null, runStatus: null,
      requestedRootUrl: null, rootUrl: null, complete: false, termination: null, detailsAvailable: false,
      counts: { pagesDiscovered: 0, pagesFetched: 0, pagesEligible: 0, edges: 0, findings: 0 },
      deadLinks: { state: 'unavailable' },
    }).hasCrawlData).toBe(false)

    expect(siteCrawlDeadLinksResponseSchema.parse({
      project: 'example', runId: 'run-1', state: 'disabled', checkDeadLinks: false,
    }).state).toBe('disabled')
  })

  it('models a bounded graph projection separately from the full crawl', () => {
    expect(siteCrawlGraphResponseSchema.parse({
      project: 'example', hasCrawlData: true, runId: 'run-1', rootNodeKey: 'home',
      layout: {
        state: 'ready', version: 'site-health-fa2-v1', computedAt: '2026-08-09T12:00:00.000Z',
        templateLinksExcluded: true,
      },
      templateDetection: 'applied', linkKind: 'all',
      totalNodes: 1_284, totalEdges: 18_402, totalTemplateEdges: 15_902, totalContentEdges: 2_500,
      nodes: [{
        nodeKey: 'home', url: 'https://example.com/', path: '/', fetchState: 'html',
        indexabilityState: 'indexable', auditState: 'success', auditScore: 94,
        inventoryEligible: true, depth: 0, inboundUniqueEdges: 10, outboundUniqueEdges: 20,
        linkScoreNormalized: 1, healthState: 'eligible',
        x: 0, y: 0,
      }], edges: [], omittedNodes: 684, omittedEdges: 15_402, sampled: true,
    })).toMatchObject({
      project: 'example', runId: 'run-1', sampled: true,
      // Root identity is server-owned so the home page never has to be
      // inferred from a path, a depth, or a link score.
      rootNodeKey: 'home',
      layout: { state: 'ready', version: 'site-health-fa2-v1', templateLinksExcluded: true },
      nodes: [{ nodeKey: 'home', x: 0, y: 0 }],
      // The nav mesh is counted, never folded into or subtracted from the
      // total the summary already reports.
      templateDetection: 'applied',
      totalEdges: 18_402,
      totalTemplateEdges: 15_902,
      totalContentEdges: 2_500,
    })

    const empty = siteCrawlGraphResponseSchema.parse({
      project: 'example', hasCrawlData: false, runId: null, rootNodeKey: null,
      layout: { state: 'unavailable', version: null, reason: 'no-crawl' },
      templateDetection: 'unavailable-legacy-scan', linkKind: 'all',
      totalNodes: 0, totalEdges: 0, totalTemplateEdges: 0, totalContentEdges: 0,
      nodes: [], edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
    })
    expect(empty.hasCrawlData).toBe(false)
    expect(empty.rootNodeKey).toBeNull()

    expect(siteCrawlGraphResponseSchema.parse({
      project: 'example', hasCrawlData: true, runId: 'legacy-run', rootNodeKey: 'home',
      layout: { state: 'unavailable', version: null, reason: 'legacy-snapshot' },
      templateDetection: 'unavailable-legacy-scan', linkKind: 'all',
      totalNodes: 0, totalEdges: 0, totalTemplateEdges: 0, totalContentEdges: 0,
      nodes: [], edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
    }).layout).toEqual({ state: 'unavailable', version: null, reason: 'legacy-snapshot' })
  })

  it('ties one persisted page score to exact audit findings without bloating the graph DTO', () => {
    expect(siteCrawlPageAuditSchema.parse({
      state: 'ready',
      project: 'example',
      runId: 'run-1',
      complete: true,
      termination: null,
      nodeKey: 'guide',
      url: 'https://example.com/guide',
      auditState: 'complete',
      auditScore: 42,
      evidenceState: 'complete',
      factors: [{
        id: 'content-depth',
        name: 'Content Depth',
        weight: 12,
        score: 20,
        status: 'fail',
        applicable: true,
        findings: [{
          type: 'missing',
          code: 'content-depth.word-count.low',
          message: 'Low content depth (120 words).',
        }],
        recommendations: ['Add more comprehensive copy covering key user questions.'],
      }],
      criticalDefects: [{
        id: 'missing-h1',
        severity: 'critical',
        detail: 'No H1 tag found.',
        recommendation: 'Add one descriptive H1.',
      }],
    })).toMatchObject({
      state: 'ready',
      project: 'example',
      runId: 'run-1',
      nodeKey: 'guide',
      auditScore: 42,
      evidenceState: 'complete',
      factors: [{
        id: 'content-depth',
        score: 20,
        status: 'fail',
        findings: [{ code: 'content-depth.word-count.low' }],
      }],
      criticalDefects: [{ id: 'missing-h1', severity: 'critical' }],
    })

    expect(siteCrawlPageAuditSchema.parse({
      state: 'not-audited', project: 'example', runId: 'run-1', complete: false,
      termination: 'max-pages', nodeKey: 'deep', url: 'https://example.com/deep',
      auditState: 'pending', auditScore: null,
    })).toMatchObject({ state: 'not-audited', factors: [], criticalDefects: [] })
  })

  it('derives one shared Site Health state from exact crawl states and canonical identity', () => {
    expect(deriveSiteHealthState({ fetchState: 'html', indexabilityState: 'indexable' })).toBe('eligible')
    expect(deriveSiteHealthState({ fetchState: 'html', indexabilityState: 'noindex' })).toBe('hidden')
    expect(deriveSiteHealthState({ fetchState: 'fetch-error', indexabilityState: 'indexable' })).toBe('failed')
    expect(deriveSiteHealthState({ fetchState: 'discovered', indexabilityState: 'unknown' })).toBe('unchecked')
    // "Hidden" is a claim that the SITE said not to index. A redirect and a
    // non-HTML resource say no such thing, and calling them hidden reads as a
    // defect: it is actively wrong for llms.txt, whose purpose is to be read.
    expect(deriveSiteHealthState({ fetchState: 'redirect', indexabilityState: 'unknown' })).toBe('redirect')
    expect(deriveSiteHealthState({ fetchState: 'non-html', indexabilityState: 'unknown' })).toBe('resource')
    expect(deriveSiteHealthState({ fetchState: 'non-html', indexabilityState: 'indexable' })).toBe('resource')
    // robots.txt IS the site saying no, so it stays with the hidden pages.
    expect(deriveSiteHealthState({ fetchState: 'robots-blocked', indexabilityState: 'unknown' })).toBe('hidden')
    expect(deriveSiteHealthState({
      fetchState: 'html',
      indexabilityState: 'unknown',
      indexabilityReasons: ['canonical-to-other'],
    })).toBe('hidden')
    expect(deriveSiteHealthState({
      nodeKey: 'page:source',
      canonicalNodeKey: 'page:canonical',
      fetchState: 'html',
      indexabilityState: 'indexable',
    })).toBe('hidden')
    expect(deriveSiteHealthState({
      nodeKey: 'page:canonical',
      canonicalNodeKey: 'page:canonical',
      fetchState: 'html',
      indexabilityState: 'indexable',
    })).toBe('eligible')
  })

  it('does not sniff unpinned string values or compare raw canonical URLs', () => {
    expect(deriveSiteHealthState({
      fetchState: 'fetch-error-but-not-a-crawler-state',
      indexabilityState: 'indexable',
    })).toBe('unchecked')
    const trailingSlashDifference = {
      fetchState: 'html',
      indexabilityState: 'indexable',
      // A trailing-slash presentation difference is not canonical-away evidence.
      canonicalUrl: 'https://example.com/page/',
      url: 'https://example.com/page',
    } as unknown as Parameters<typeof deriveSiteHealthState>[0]
    expect(deriveSiteHealthState(trailingSlashDifference)).toBe('eligible')
  })

  it('models scan history so a legacy score-only scan is listed, not hidden', () => {
    const parsed = siteHealthScansResponseSchema.parse({
      project: 'example',
      scans: [
        {
          runId: 'run-2', status: 'queued', createdAt: '2026-08-09T13:00:00.000Z',
          startedAt: null, finishedAt: null, hasCrawlData: false,
        },
        {
          runId: 'run-1', status: 'completed', createdAt: '2026-08-09T12:00:00.000Z',
          startedAt: '2026-08-09T12:00:01.000Z', finishedAt: '2026-08-09T12:04:00.000Z',
          hasCrawlData: false,
        },
      ],
    })

    expect(parsed.scans.map((entry) => entry.runId)).toEqual(['run-2', 'run-1'])
    // A completed scan with no crawl is a real, selectable score-only scan.
    expect(parsed.scans[1]!.hasCrawlData).toBe(false)
    expect(siteHealthScansResponseSchema.parse({ project: 'example' }).scans).toEqual([])
    expect(SITE_HEALTH_SCANS_DEFAULT_LIMIT).toBe(20)
    expect(SITE_HEALTH_SCANS_MAX_LIMIT).toBe(100)
  })

  it('does not call an AI-access file hidden', () => {
    // Reported on the shipped build: /llms-full.txt rendered as "Hidden" over
    // "Not a reachable HTML page". Both halves were wrong. These files exist
    // to be fetched by answer engines, so flagging them reads as a defect
    // when their presence is the good outcome.
    const llmsFullTxt = {
      fetchState: 'non-html',
      indexabilityState: 'unknown',
      indexabilityReasons: ['not-html-or-unavailable'],
      nodeKey: 'page:llms-full',
    }
    expect(deriveSiteHealthState(llmsFullTxt)).toBe('resource')
    expect(deriveSiteHealthState(llmsFullTxt)).not.toBe('hidden')

    // A PDF is the same kind of thing.
    expect(deriveSiteHealthState({ fetchState: 'non-html', indexabilityState: 'noindex' })).toBe('resource')
  })

  it('keeps every state distinct, so nothing silently rejoins the hidden bucket', () => {
    const states = new Set(siteHealthStateSchema.options)
    expect(states).toEqual(new Set(['eligible', 'hidden', 'resource', 'redirect', 'failed', 'unchecked']))

    // Each crawler fetch state maps somewhere deliberate.
    const byFetchState = Object.fromEntries(
      ['discovered', 'robots-blocked', 'html', 'redirect', 'non-html', 'fetch-error'].map((fetchState) => [
        fetchState,
        deriveSiteHealthState({ fetchState, indexabilityState: 'indexable' }),
      ]),
    )
    expect(byFetchState).toEqual({
      'discovered': 'unchecked',
      'robots-blocked': 'hidden',
      'html': 'eligible',
      'redirect': 'redirect',
      'non-html': 'resource',
      'fetch-error': 'failed',
    })
  })
})
