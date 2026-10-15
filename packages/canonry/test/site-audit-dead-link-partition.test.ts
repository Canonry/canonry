import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  runs,
  siteCrawlFindings,
  siteCrawlSnapshots,
} from '@canonry/canonry-db'

vi.mock('@canonry/aeo-audit', () => ({ runSiteCrawl: vi.fn() }))
vi.mock('@canonry/canonry-api-routes', () => ({
  resolvePublicHttpTarget: vi.fn(),
  resolveWebhookTarget: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../src/site-audit-root.js', () => ({
  resolveSiteAuditRootUrl: vi.fn(async (url: string) => {
    const normalizedUrl = new URL(url).href
    return { requestedUrl: normalizedUrl, effectiveUrl: normalizedUrl, redirects: [] }
  }),
}))

import { runSiteCrawl } from '@canonry/aeo-audit'
import { executeSiteAudit } from '../src/execute-site-audit.js'

const NOW = '2026-08-16T00:00:00.000Z'
const ROOT = 'https://example.com/'
const GONE = 'https://example.com/gone'
const FLAKY = 'https://example.com/flaky'

/**
 * The invariant these lock down: a row in `site_crawl_findings` means the
 * target ANSWERED with an error status. The engine (6.0.0+) makes the
 * broken-vs-unverified split itself — `findings` always carry a real status,
 * `unverified` carries the targets the crawl could not check — and the
 * platform must persist exactly that split, because every reader of the
 * findings table — the API route, the CLI, the dashboard — renders a row as a
 * broken link.
 */
function pageRow(key: string, url: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    requestedUrl: url,
    finalUrl: url,
    state: 'html',
    depth: url === ROOT ? 0 : 1,
    provenance: { discoveredFrom: [], sitemapSources: [], root: url === ROOT },
    statusCode: 200,
    contentType: 'text/html',
    redirectChain: [],
    canonicalUrl: url,
    metaRobots: [],
    xRobots: [],
    path: new URL(url).pathname,
    directory: '/',
    indexability: { state: 'indexable', reasons: [], rulesetVersion: '1.0.0' },
    audit: {
      url,
      finalUrl: url,
      auditedAt: NOW,
      overallScore: 88,
      factors: [{ id: 'sd', name: 'Structured Data', weight: 12, score: 88, findings: [], recommendations: [] }],
      criticalDefects: [],
    },
    error: null,
    metrics: {
      inbound: { totalOccurrences: 0, uniqueEdges: 0 },
      outbound: { totalOccurrences: 0, uniqueEdges: 0 },
      shortestFollowableAnchorDepth: url === ROOT ? 0 : 1,
      linkScoreRaw: 0.5,
      linkScore: 100,
    },
    ...overrides,
  }
}

/** A target that answered 404 — genuinely broken. */
const goneRow = pageRow('page:gone', GONE, {
  state: 'fetch-error', statusCode: 404, audit: null, error: 'HTTP 404',
  indexability: { state: 'unknown', reasons: [], rulesetVersion: '1.0.0' },
})

/** A target the crawler never got an answer from — state unknown, not broken. */
const flakyRow = pageRow('page:flaky', FLAKY, {
  state: 'fetch-error', statusCode: null, audit: null, error: 'Target URL could not be reached.',
  finalUrl: null,
  indexability: { state: 'unknown', reasons: [], rulesetVersion: '1.0.0' },
})

function anchorEdge(key: string, to: string) {
  return {
    key, from: ROOT, to, type: 'anchor', classification: 'internal',
    totalOccurrences: 1, followableOccurrences: 1, nofollowOccurrences: 0, anchorSummaries: [],
  }
}

function crawlSummary() {
  return {
    crawlSchemaVersion: '2.0',
    engineVersion: '7.1.0',
    crawlEngineVersion: '2.2.0',
    urlNormalizationVersion: '1.1.0',
    indexabilityRulesetVersion: '1.0.0',
    linkScoreAlgorithmVersion: 'pagerank-1.0.0',
    rootUrl: ROOT,
    finalRootUrl: ROOT,
    startedAt: NOW,
    completedAt: NOW,
    complete: true,
    terminationReason: null,
    pagesDiscovered: 3,
    pagesFetched: 3,
    pagesObserved: 3,
    edgesObserved: 2,
    bytesRead: 100,
    fetchesStarted: 3,
    elapsedMs: 10,
    limits: {
      maxPages: 500, maxEdges: 10_000, maxFetches: 5000, maxDurationMs: 120_000, maxBytes: 1_000_000,
      maxPageBytes: 100_000, maxDepth: 10, maxLinksPerPage: 1000, maxQueryVariants: 10,
      maxSitemapFanout: 1000, maxSitemapUrls: 50_000, concurrency: 1,
    },
    auditRollup: { auditedPages: 1, aggregateScore: 88, factors: [{ id: 'sd', name: 'Structured Data', count: 1, averageScore: 88 }] },
  }
}

/** Emits the graph, then returns whatever `deadLinks` shape the engine version would. */
async function emitGraph(
  options: { onEvent?: (event: unknown) => Promise<void> | void },
  deadLinks: unknown,
) {
  await options.onEvent?.({
    type: 'pages', sequence: 1, batchId: 'pages-1', checksum: 'pages',
    rows: [pageRow('page:root', ROOT), goneRow, flakyRow],
  })
  await options.onEvent?.({
    type: 'edges', sequence: 2, batchId: 'edges-1', checksum: 'edges',
    rows: [anchorEdge('edge:gone', GONE), anchorEdge('edge:flaky', FLAKY)],
  })
  const endSummary = crawlSummary()
  await options.onEvent?.({ type: 'summary', sequence: 3, batchId: 'summary-1', checksum: 'summary', summary: endSummary })
  return { mode: 'summary', summary: endSummary, deadLinks }
}

describe('site audit persists broken links and unfetchable links as different things', () => {
  let tmpDir: string
  let db: ReturnType<typeof createClient>
  let projectId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-dead-link-partition-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId, name: 'p', displayName: 'P', canonicalDomain: 'example.com', country: 'US', language: 'en',
      providers: [], locations: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    vi.mocked(runSiteCrawl).mockReset()
  })

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  function seedRun(): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({ id, projectId, kind: 'site-audit', status: 'queued', trigger: 'manual', createdAt: NOW }).run()
    return id
  }

  async function run(deadLinks: unknown) {
    vi.mocked(runSiteCrawl).mockImplementation(async (_url, options) => emitGraph(options, deadLinks) as never)
    const runId = seedRun()
    await executeSiteAudit(db, runId, projectId, { checkDeadLinks: true })
    const snapshot = db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, runId)).get()!
    const findings = db.select().from(siteCrawlFindings).where(eq(siteCrawlFindings.runId, runId)).all()
    return { snapshot, findings }
  }

  /** How the engine reports it from 6.0.0: the split already made upstream. */
  const splitEngineDeadLinks = {
    state: 'complete',
    findings: [
      { key: 'dead-link:gone', from: ROOT, to: GONE, statusCode: 404, reason: 'http-error' },
    ],
    unverified: [
      { key: 'unverified-link:flaky', from: ROOT, to: FLAKY, reason: 'unreachable', error: 'Target URL could not be reached.', statusCode: null },
    ],
  }

  it('persists a finding as a broken link and an unverified target as a count only', async () => {
    const { snapshot, findings } = await run(splitEngineDeadLinks)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ findingType: 'dead-link', targetUrl: GONE })
    expect(findings[0]!.evidence).toMatchObject({ statusCode: 404, reason: 'http-error' })
    // The original regression: no persisted row may carry a null status,
    // because every reader renders a row as a broken link.
    expect(findings.some((row) => (row.evidence as { statusCode?: unknown }).statusCode === null)).toBe(false)

    expect(snapshot.deadLinksFound).toBe(1)
    expect(snapshot.deadLinksUnverified).toBe(1)
    expect(snapshot.findingsCount).toBe(1)
  })

  it('does not count an unfetchable target as checked', async () => {
    // Two internal anchor targets, one of which never answered. Calling both
    // "checked" is the second half of the overstatement: it makes 1 broken out
    // of 2 checked look like full coverage of the link graph.
    const { snapshot } = await run(splitEngineDeadLinks)
    expect(snapshot.deadLinksChecked).toBe(1)
  })

  it('found + unverified never exceeds checked + unverified, and neither double-counts', async () => {
    const { snapshot } = await run(splitEngineDeadLinks)
    // The 404 target is both checked and found; the flaky target is neither.
    expect(snapshot.deadLinksFound).toBeLessThanOrEqual(snapshot.deadLinksChecked)
    expect(snapshot.deadLinksChecked + snapshot.deadLinksUnverified).toBe(2)
  })

  it('counts one unreachable target once, however many pages link to it', async () => {
    // `deadLinksUnverified` pairs with `deadLinksChecked`, which counts unique
    // TARGETS — so the two partition the attempted targets and can be read
    // against each other. The engine reports one row per (from, to) edge, so
    // counting rows here would print "3 unchecked" for a single unreachable
    // URL and state two different units as one comparison. This is the case
    // the original fixture could not see: every target had exactly one inbound
    // edge, which makes per-edge and per-target identical.
    const { snapshot } = await run({
      state: 'complete',
      findings: [],
      unverified: [
        { key: 'unverified-link:a', from: ROOT, to: FLAKY, reason: 'unreachable', error: 'timeout', statusCode: null },
        { key: 'unverified-link:b', from: GONE, to: FLAKY, reason: 'unreachable', error: 'timeout', statusCode: null },
        { key: 'unverified-link:c', from: 'https://example.com/other', to: FLAKY, reason: 'unreachable', error: 'timeout', statusCode: null },
      ],
    })

    expect(snapshot.deadLinksUnverified).toBe(1)
  })

  it('a throttled target is unchecked, not broken', async () => {
    // 429 is the server describing OUR request rate, so the engine reports it
    // `unverified` with `reason: 'throttled'` rather than as a finding. The
    // platform must keep that reading: counted as unchecked, never persisted
    // as a broken link.
    const { snapshot, findings } = await run({
      state: 'complete',
      findings: [
        { key: 'dead-link:gone', from: ROOT, to: GONE, statusCode: 404, reason: 'http-error' },
      ],
      unverified: [
        { key: 'unverified-link:busy', from: ROOT, to: FLAKY, reason: 'throttled', error: 'HTTP 429', statusCode: 429 },
      ],
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ targetUrl: GONE })
    expect(findings.some((row) => (row.evidence as { statusCode?: unknown }).statusCode === 429)).toBe(false)
    expect(snapshot.deadLinksFound).toBe(1)
    expect(snapshot.deadLinksUnverified).toBe(1)
  })

  it('keeps every 4xx and 5xx finding a dead link', async () => {
    // The engine's split must not cost us real evidence: 404/410/500/503 all
    // arrive as findings and all persist as findings.
    const { snapshot, findings } = await run({
      state: 'complete',
      findings: [404, 410, 500, 503].map((statusCode, index) => ({
        key: `dead-link:${statusCode}`,
        from: ROOT,
        to: `https://example.com/broken-${index}`,
        statusCode,
        reason: 'http-error',
      })),
      unverified: [],
    })

    expect(findings).toHaveLength(4)
    expect(snapshot.deadLinksFound).toBe(4)
    expect(snapshot.deadLinksUnverified).toBe(0)
  })

  it('a clean crawl reports zero of both, so the counts are not merely never-zero', async () => {
    const { snapshot, findings } = await run({ state: 'complete', findings: [], unverified: [] })
    expect(findings).toHaveLength(0)
    expect(snapshot.deadLinksFound).toBe(0)
    expect(snapshot.deadLinksUnverified).toBe(0)
  })

  it('an all-unfetchable crawl reports zero broken links, not one per link', async () => {
    // Every target unverified, nothing genuinely broken. The output must be
    // "we could not check these", never "2 broken".
    const { snapshot, findings } = await run({
      state: 'complete',
      findings: [],
      unverified: [
        { key: 'unverified-link:a', from: ROOT, to: FLAKY, reason: 'unreachable', error: 'timeout', statusCode: null },
        { key: 'unverified-link:b', from: GONE, to: FLAKY, reason: 'unreachable', error: 'timeout', statusCode: null },
      ],
    })

    expect(findings).toHaveLength(0)
    expect(snapshot.deadLinksFound).toBe(0)
    // Two edge-level rows, both pointing at the SAME unreachable URL: one
    // unchecked target.
    expect(snapshot.deadLinksUnverified).toBe(1)
  })
})
