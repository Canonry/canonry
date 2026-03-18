import { eq, desc, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { querySnapshots, runs, keywords } from '@ainyc/canonry-db'
import { categorizeSource, categoryLabel } from '@ainyc/canonry-contracts'
import type {
  BrandMetricsDto, GapAnalysisDto, SourceBreakdownDto,
  MetricsWindow, TimeBucket, TrendDirection, GapKeyword, GapCategory,
  SourceCategory, SourceCategoryCount, ProviderMetric,
} from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

export async function analyticsRoutes(app: FastifyInstance) {
  // GET /projects/:name/analytics/metrics — citation rate trends
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/analytics/metrics', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const window = parseWindow(request.query.window)
    const cutoff = windowCutoff(window)

    const projectRuns = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(runs.createdAt)
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
      .filter(r => !cutoff || r.createdAt >= cutoff)

    if (projectRuns.length === 0) {
      return reply.send({
        window,
        buckets: [],
        overall: { citationRate: 0, cited: 0, total: 0 },
        byProvider: {},
        trend: 'stable',
      } satisfies BrandMetricsDto)
    }

    const runIds = projectRuns.map(r => r.id)
    const allSnapshots = app.db
      .select({
        runId: querySnapshots.runId,
        keywordId: querySnapshots.keywordId,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        createdAt: querySnapshots.createdAt,
      })
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, runIds))
      .all()

    // Overall metrics
    const overall = computeProviderMetric(allSnapshots)

    // Per-provider metrics
    const byProvider: Record<string, ProviderMetric> = {}
    const providers = new Set(allSnapshots.map(s => s.provider))
    for (const p of providers) {
      byProvider[p] = computeProviderMetric(allSnapshots.filter(s => s.provider === p))
    }

    // Time buckets — size based on actual data span, not the selected window
    const earliest = new Date(projectRuns[0]!.createdAt)
    const latest = new Date(projectRuns[projectRuns.length - 1]!.createdAt)
    const spanDays = Math.max(1, Math.ceil((latest.getTime() - earliest.getTime()) / 86_400_000))
    const bucketSize = bucketSizeForSpan(spanDays)
    const buckets = computeBuckets(allSnapshots, projectRuns, bucketSize)

    // Trend
    const trend = computeTrend(buckets)

    return reply.send({ window, buckets, overall, byProvider, trend } satisfies BrandMetricsDto)
  })

  // GET /projects/:name/analytics/gaps — brand gap analysis
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/analytics/gaps', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const window = parseWindow(request.query.window)
    const cutoff = windowCutoff(window)

    // Find the latest completed or partial run (determines classification)
    const latestRun = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(desc(runs.createdAt))
      .all()
      .find(r => r.status === 'completed' || r.status === 'partial')

    if (!latestRun) {
      return reply.send({ cited: [], gap: [], uncited: [], runId: '', window } satisfies GapAnalysisDto)
    }

    // All runs in window (for consistency signal)
    const windowRuns = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(runs.createdAt)
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
      .filter(r => !cutoff || r.createdAt >= cutoff)

    const windowRunIds = windowRuns.map(r => r.id)

    // Consistency: for each keyword, count how many runs cited it
    const consistencyMap = new Map<string, { citedRuns: Set<string>; totalRuns: Set<string> }>()
    if (windowRunIds.length > 0) {
      const allWindowSnaps = app.db
        .select({
          keywordId: querySnapshots.keywordId,
          runId: querySnapshots.runId,
          citationState: querySnapshots.citationState,
        })
        .from(querySnapshots)
        .where(inArray(querySnapshots.runId, windowRunIds))
        .all()

      for (const s of allWindowSnaps) {
        let entry = consistencyMap.get(s.keywordId)
        if (!entry) {
          entry = { citedRuns: new Set(), totalRuns: new Set() }
          consistencyMap.set(s.keywordId, entry)
        }
        entry.totalRuns.add(s.runId)
        if (s.citationState === 'cited') entry.citedRuns.add(s.runId)
      }
    }

    // Latest-run snapshots (determines classification)
    const snapshots = app.db
      .select({
        keywordId: querySnapshots.keywordId,
        keyword: keywords.keyword,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        competitorOverlap: querySnapshots.competitorOverlap,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(eq(querySnapshots.runId, latestRun.id))
      .all()

    // Group by keyword
    const byKeyword = new Map<string, typeof snapshots>()
    for (const s of snapshots) {
      const key = s.keywordId
      const arr = byKeyword.get(key)
      if (arr) arr.push(s)
      else byKeyword.set(key, [s])
    }

    const cited: GapKeyword[] = []
    const gap: GapKeyword[] = []
    const uncited: GapKeyword[] = []

    for (const [keywordId, kwSnapshots] of byKeyword) {
      const keyword = kwSnapshots[0]?.keyword ?? ''
      const citedProviders = kwSnapshots
        .filter(s => s.citationState === 'cited')
        .map(s => s.provider)
      const competitorsCiting = new Set<string>()
      for (const s of kwSnapshots) {
        const overlap = tryParseJson(s.competitorOverlap, [] as string[])
        for (const c of overlap) competitorsCiting.add(c)
      }

      let category: GapCategory
      if (citedProviders.length > 0) {
        category = 'cited'
      } else if (competitorsCiting.size > 0) {
        category = 'gap'
      } else {
        category = 'uncited'
      }

      const cons = consistencyMap.get(keywordId)
      const entry: GapKeyword = {
        keyword,
        keywordId,
        category,
        providers: citedProviders,
        competitorsCiting: [...competitorsCiting],
        consistency: {
          citedRuns: cons?.citedRuns.size ?? 0,
          totalRuns: cons?.totalRuns.size ?? 0,
        },
      }

      if (category === 'cited') cited.push(entry)
      else if (category === 'gap') gap.push(entry)
      else uncited.push(entry)
    }

    // Sort: gap by most competitors, cited/uncited alphabetically
    gap.sort((a, b) => b.competitorsCiting.length - a.competitorsCiting.length)
    cited.sort((a, b) => a.keyword.localeCompare(b.keyword))
    uncited.sort((a, b) => a.keyword.localeCompare(b.keyword))

    return reply.send({ cited, gap, uncited, runId: latestRun.id, window } satisfies GapAnalysisDto)
  })

  // GET /projects/:name/analytics/sources — source origin breakdown
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/analytics/sources', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const window = parseWindow(request.query.window)
    const cutoff = windowCutoff(window)

    // All runs in window
    const windowRuns = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(desc(runs.createdAt))
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
      .filter(r => !cutoff || r.createdAt >= cutoff)

    if (windowRuns.length === 0) {
      return reply.send({ overall: [], byKeyword: {}, runId: '', window } satisfies SourceBreakdownDto)
    }

    const latestRunId = windowRuns[0]!.id
    const windowRunIds = windowRuns.map(r => r.id)

    const snapshots = app.db
      .select({
        keywordId: querySnapshots.keywordId,
        keyword: keywords.keyword,
        rawResponse: querySnapshots.rawResponse,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(inArray(querySnapshots.runId, windowRunIds))
      .all()

    // Aggregate sources overall and per-keyword
    const overallCounts = new Map<SourceCategory, Map<string, number>>()
    const byKeyword: Record<string, SourceCategoryCount[]> = {}

    for (const snap of snapshots) {
      const sources = parseGroundingSources(snap.rawResponse)
      const kwCounts = new Map<SourceCategory, Map<string, number>>()

      for (const source of sources) {
        const { category, domain } = categorizeSource(source.uri)

        // Overall
        if (!overallCounts.has(category)) overallCounts.set(category, new Map())
        const oDomains = overallCounts.get(category)!
        oDomains.set(domain, (oDomains.get(domain) ?? 0) + 1)

        // Per-keyword
        if (!kwCounts.has(category)) kwCounts.set(category, new Map())
        const kDomains = kwCounts.get(category)!
        kDomains.set(domain, (kDomains.get(domain) ?? 0) + 1)
      }

      if (sources.length > 0 && snap.keyword) {
        byKeyword[snap.keyword] = buildCategoryCounts(kwCounts)
      }
    }

    const overall = buildCategoryCounts(overallCounts)

    return reply.send({ overall, byKeyword, runId: latestRunId, window } satisfies SourceBreakdownDto)
  })
}

// --- Helpers ---

function resolveProjectSafe(app: FastifyInstance, name: string, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  try {
    return resolveProject(app.db, name)
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
      const err = e as { statusCode: number; toJSON(): unknown }
      reply.status(err.statusCode).send(err.toJSON())
      return null
    }
    throw e
  }
}

function tryParseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

// Domains that are provider infrastructure, not real grounding sources
const PROVIDER_INFRA_DOMAINS = new Set([
  'vertexaisearch.cloud.google.com',
  'openai.com',
  'anthropic.com',
  'googleapis.com',
])

function isProviderInfraDomain(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase()
    for (const blocked of PROVIDER_INFRA_DOMAINS) {
      if (host === blocked || host.endsWith(`.${blocked}`)) return true
    }
  } catch {
    // malformed URI — skip
  }
  return false
}

function parseGroundingSources(rawResponse: string | null): Array<{ uri: string; title: string }> {
  const parsed = tryParseJson(rawResponse, {} as Record<string, unknown>)
  const sources = parsed.groundingSources as Array<{ uri?: string; title?: string }> | undefined
  if (!Array.isArray(sources)) return []
  return sources.filter(
    (s): s is { uri: string; title: string } =>
      typeof s.uri === 'string' && !isProviderInfraDomain(s.uri),
  )
}

function parseWindow(value?: string): MetricsWindow {
  if (value === '7d' || value === '30d' || value === '90d' || value === 'all') return value
  return 'all'
}

function windowCutoff(window: MetricsWindow): string | null {
  if (window === 'all') return null
  const days = window === '7d' ? 7 : window === '30d' ? 30 : 90
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

function bucketSizeForSpan(spanDays: number): number {
  // Pick a bucket size based on how many days of data actually exist
  if (spanDays <= 14) return 1   // daily
  if (spanDays <= 60) return 7   // weekly
  if (spanDays <= 180) return 14 // bi-weekly
  return 30                       // monthly
}

interface SnapshotLike {
  citationState: string
  createdAt: string
}

function computeProviderMetric(snapshots: SnapshotLike[]): ProviderMetric {
  const total = snapshots.length
  const cited = snapshots.filter(s => s.citationState === 'cited').length
  return {
    citationRate: total > 0 ? Math.round((cited / total) * 10000) / 10000 : 0,
    cited,
    total,
  }
}

function computeBuckets(
  snapshots: SnapshotLike[],
  projectRuns: Array<{ createdAt: string }>,
  bucketDays: number,
): TimeBucket[] {
  if (projectRuns.length === 0) return []

  const earliest = new Date(projectRuns[0]!.createdAt)
  const latest = new Date(projectRuns[projectRuns.length - 1]!.createdAt)
  const buckets: TimeBucket[] = []

  let start = new Date(earliest)
  start.setHours(0, 0, 0, 0)

  while (start <= latest) {
    const end = new Date(start)
    end.setDate(end.getDate() + bucketDays)

    const startISO = start.toISOString()
    const endISO = end.toISOString()
    const inBucket = snapshots.filter(s => s.createdAt >= startISO && s.createdAt < endISO)
    const metric = computeProviderMetric(inBucket)

    buckets.push({
      startDate: startISO,
      endDate: endISO,
      citationRate: metric.citationRate,
      cited: metric.cited,
      total: metric.total,
    })

    start = end
  }

  return buckets
}

function computeTrend(buckets: TimeBucket[]): TrendDirection {
  const nonEmpty = buckets.filter(b => b.total > 0)
  if (nonEmpty.length < 2) return 'stable'

  const mid = Math.floor(nonEmpty.length / 2)
  const firstHalf = nonEmpty.slice(0, mid)
  const secondHalf = nonEmpty.slice(mid)

  const avgFirst = firstHalf.reduce((s, b) => s + b.citationRate, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((s, b) => s + b.citationRate, 0) / secondHalf.length

  const diff = avgSecond - avgFirst
  // Threshold: 5 percentage points
  if (diff > 0.05) return 'improving'
  if (diff < -0.05) return 'declining'
  return 'stable'
}

function buildCategoryCounts(counts: Map<SourceCategory, Map<string, number>>): SourceCategoryCount[] {
  let grandTotal = 0
  for (const domains of counts.values()) {
    for (const count of domains.values()) grandTotal += count
  }

  const result: SourceCategoryCount[] = []
  for (const [category, domains] of counts) {
    let categoryTotal = 0
    const domainEntries: Array<{ domain: string; count: number }> = []
    for (const [domain, count] of domains) {
      categoryTotal += count
      domainEntries.push({ domain, count })
    }
    domainEntries.sort((a, b) => b.count - a.count)

    result.push({
      category,
      label: categoryLabel(category),
      count: categoryTotal,
      percentage: grandTotal > 0 ? Math.round((categoryTotal / grandTotal) * 10000) / 10000 : 0,
      topDomains: domainEntries.slice(0, 5),
    })
  }

  result.sort((a, b) => b.count - a.count)
  return result
}
