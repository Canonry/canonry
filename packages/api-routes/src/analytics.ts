import { eq, desc, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { filterTrackedSnapshots, groupRunsByCreatedAt, pickGroupRepresentative, querySnapshots, runs, queries, parseJsonColumn } from '@ainyc/canonry-db'
import { categorizeSource, categoryLabel, CitationStates, parseWindow, windowCutoff } from '@ainyc/canonry-contracts'
import type {
  BrandMetricsDto, GapAnalysisDto, SourceBreakdownDto,
  MetricsWindow, TimeBucket, TrendDirection, GapQuery, GapCategory,
  SourceCategory, SourceCategoryCount, ProviderMetric, QueryChangeEvent,
} from '@ainyc/canonry-contracts'
import { resolveProject, resolveSnapshotAnswerMentioned } from './helpers.js'

export async function analyticsRoutes(app: FastifyInstance) {
  // GET /projects/:name/analytics/metrics — citation rate trends
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/analytics/metrics', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

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
        overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
        byProvider: {},
        trend: 'stable',
        mentionTrend: 'stable',
        queryChanges: [],
      } satisfies BrandMetricsDto)
    }

    const runIds = projectRuns.map(r => r.id)
    // Orphan snapshots (queryId NULL post-v58 — see schema.ts) can't be
    // grouped by query; drop them at load so downstream `byQuery` keys stay
    // valid `string`s.
    const rawSnapshots = filterTrackedSnapshots(app.db
      .select({
        runId: querySnapshots.runId,
        queryId: querySnapshots.queryId,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
        createdAt: querySnapshots.createdAt,
      })
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, runIds))
      .all())

    // Resolve answerMentioned for each snapshot (handles null/legacy data)
    const allSnapshots = rawSnapshots.map(s => ({
      ...s,
      resolvedMentioned: resolveSnapshotAnswerMentioned(s, project),
    }))

    // Fetch query creation dates for normalization
    const projectQueries = app.db
      .select({ id: queries.id, createdAt: queries.createdAt })
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()
    const queryCreatedAt = new Map(projectQueries.map(q => [q.id, q.createdAt]))

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
    const buckets = computeBuckets(allSnapshots, projectRuns, bucketSize, queryCreatedAt)

    // Trends
    const trend = computeTrend(buckets, 'citationRate')
    const mentionTrend = computeTrend(buckets, 'mentionRate')

    // Query change annotations
    const queryChanges = computeQueryChanges(projectQueries, cutoff)

    return reply.send({ window, buckets, overall, byProvider, trend, mentionTrend, queryChanges } satisfies BrandMetricsDto)
  })

  // GET /projects/:name/analytics/gaps — brand gap analysis
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/analytics/gaps', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const window = parseWindow(request.query.window)
    const cutoff = windowCutoff(window)

    // Find the latest completed-or-partial fan-out group. Multi-location
    // `--all-locations` sweeps share `createdAt`; the group is the unit and
    // classification reads snapshots across all locations in it. The single
    // `runId` returned in the response is the deterministic representative
    // (id DESC tiebreak) so callers get a stable id. See #480.
    const completedRuns = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
    const latestGroup = groupRunsByCreatedAt(completedRuns)[0] ?? []
    const latestGroupRunIds = latestGroup.map(r => r.id)
    const latestRun = pickGroupRepresentative(latestGroup)

    if (!latestRun) {
      return reply.send({ cited: [], gap: [], uncited: [], mentionedQueries: [], mentionGap: [], notMentioned: [], runId: '', window } satisfies GapAnalysisDto)
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
    // Map runId → createdAt so we can key consistency sets by time-point
    // instead of by raw runId. Under `--all-locations` fan-out, a single
    // time-point has N runs (one per location); keying by runId would
    // double-count the same time-point N times for multi-location projects.
    // See #480.
    const runIdToCreatedAt = new Map(windowRuns.map(r => [r.id, r.createdAt]))

    // Consistency: for each query, count how many *time-points* cited/mentioned it
    const consistencyMap = new Map<string, { citedRuns: Set<string>; totalRuns: Set<string>; mentionedRuns: Set<string> }>()
    if (windowRunIds.length > 0) {
      const allWindowSnaps = filterTrackedSnapshots(app.db
        .select({
          queryId: querySnapshots.queryId,
          runId: querySnapshots.runId,
          citationState: querySnapshots.citationState,
          answerMentioned: querySnapshots.answerMentioned,
          answerText: querySnapshots.answerText,
        })
        .from(querySnapshots)
        .where(inArray(querySnapshots.runId, windowRunIds))
        .all())

      for (const s of allWindowSnaps) {
        const timePoint = runIdToCreatedAt.get(s.runId) ?? s.runId
        let entry = consistencyMap.get(s.queryId)
        if (!entry) {
          entry = { citedRuns: new Set(), totalRuns: new Set(), mentionedRuns: new Set() }
          consistencyMap.set(s.queryId, entry)
        }
        // A query is "cited at a time-point" if ANY snapshot in any of the
        // fanned-out runs at that timestamp is cited. Same for mentions.
        entry.totalRuns.add(timePoint)
        if (s.citationState === CitationStates.cited) entry.citedRuns.add(timePoint)
        if (resolveSnapshotAnswerMentioned(s, project)) entry.mentionedRuns.add(timePoint)
      }
    }

    // Latest-run snapshots (determines classification). Skip orphans
    // (queryId NULL) since byQuery keys must stay non-null.
    const rawSnapshots = filterTrackedSnapshots(app.db
      .select({
        queryId: querySnapshots.queryId,
        query: queries.query,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
        competitorOverlap: querySnapshots.competitorOverlap,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(inArray(querySnapshots.runId, latestGroupRunIds))
      .all())

    // Resolve answer mentions
    const snapshots = rawSnapshots.map(s => ({
      ...s,
      resolvedMentioned: resolveSnapshotAnswerMentioned(s, project),
    }))

    // Group by query
    const byQuery = new Map<string, typeof snapshots>()
    for (const s of snapshots) {
      const key = s.queryId
      const arr = byQuery.get(key)
      if (arr) arr.push(s)
      else byQuery.set(key, [s])
    }

    const cited: GapQuery[] = []
    const gap: GapQuery[] = []
    const uncited: GapQuery[] = []
    const mentionedQueries: GapQuery[] = []
    const mentionGap: GapQuery[] = []
    const notMentioned: GapQuery[] = []

    for (const [queryId, qSnapshots] of byQuery) {
      const query = qSnapshots[0]?.query ?? ''
      const citedProviders = qSnapshots
        .filter(s => s.citationState === CitationStates.cited)
        .map(s => s.provider)
      const mentionedProviders = qSnapshots
        .filter(s => s.resolvedMentioned)
        .map(s => s.provider)
      const competitorsCiting = new Set<string>()
      for (const s of qSnapshots) {
        const overlap = parseJsonColumn<string[]>(s.competitorOverlap, [])
        for (const c of overlap) competitorsCiting.add(c)
      }

      const cons = consistencyMap.get(queryId)
      const consistency = {
        citedRuns: cons?.citedRuns.size ?? 0,
        totalRuns: cons?.totalRuns.size ?? 0,
        mentionedRuns: cons?.mentionedRuns.size ?? 0,
      }

      // Citation-based classification (existing)
      let category: GapCategory
      if (citedProviders.length > 0) {
        category = 'cited'
      } else if (competitorsCiting.size > 0) {
        category = 'gap'
      } else {
        category = 'uncited'
      }

      const citationEntry: GapQuery = {
        query, queryId, category,
        providers: citedProviders,
        competitorsCiting: [...competitorsCiting],
        consistency,
      }

      if (category === 'cited') cited.push(citationEntry)
      else if (category === 'gap') gap.push(citationEntry)
      else uncited.push(citationEntry)

      // Answer-mention classification (new)
      let mentionCategory: GapCategory
      if (mentionedProviders.length > 0) {
        mentionCategory = 'cited'
      } else if (competitorsCiting.size > 0) {
        mentionCategory = 'gap'
      } else {
        mentionCategory = 'uncited'
      }

      const mentionEntry: GapQuery = {
        query, queryId, category: mentionCategory,
        providers: mentionedProviders,
        competitorsCiting: [...competitorsCiting],
        consistency,
      }

      if (mentionCategory === 'cited') mentionedQueries.push(mentionEntry)
      else if (mentionCategory === 'gap') mentionGap.push(mentionEntry)
      else notMentioned.push(mentionEntry)
    }

    // Sort: gap by most competitors, cited/uncited alphabetically
    gap.sort((a, b) => b.competitorsCiting.length - a.competitorsCiting.length)
    cited.sort((a, b) => a.query.localeCompare(b.query))
    uncited.sort((a, b) => a.query.localeCompare(b.query))
    mentionGap.sort((a, b) => b.competitorsCiting.length - a.competitorsCiting.length)
    mentionedQueries.sort((a, b) => a.query.localeCompare(b.query))
    notMentioned.sort((a, b) => a.query.localeCompare(b.query))

    return reply.send({ cited, gap, uncited, mentionedQueries, mentionGap, notMentioned, runId: latestRun.id, window } satisfies GapAnalysisDto)
  })

  // GET /projects/:name/analytics/sources — source origin breakdown
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/analytics/sources', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const window = parseWindow(request.query.window)
    const cutoff = windowCutoff(window)

    // All runs in window
    const windowRuns = app.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
      .filter(r => !cutoff || r.createdAt >= cutoff)

    if (windowRuns.length === 0) {
      return reply.send({ overall: [], byQuery: {}, runId: '', window } satisfies SourceBreakdownDto)
    }

    // Pick the deterministic representative of the latest fan-out group as
    // the single `runId` for the response. windowRunIds still includes every
    // run in the window — per-query consistency aggregation operates on the
    // full window so multi-location and single-location callers see the same
    // shape. See #480.
    const latestGroup = groupRunsByCreatedAt(windowRuns)[0] ?? []
    const latestRunId = pickGroupRepresentative(latestGroup)?.id ?? windowRuns[0]!.id
    const windowRunIds = windowRuns.map(r => r.id)

    const snapshots = app.db
      .select({
        queryId: querySnapshots.queryId,
        query: queries.query,
        rawResponse: querySnapshots.rawResponse,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(inArray(querySnapshots.runId, windowRunIds))
      .all()

    // Aggregate sources overall and per-query
    const overallCounts = new Map<SourceCategory, Map<string, number>>()
    const byQuery: Record<string, SourceCategoryCount[]> = {}

    for (const snap of snapshots) {
      const sources = parseGroundingSources(snap.rawResponse)
      const qCounts = new Map<SourceCategory, Map<string, number>>()

      for (const source of sources) {
        const { category, domain } = categorizeSource(source.uri)

        // Overall
        if (!overallCounts.has(category)) overallCounts.set(category, new Map())
        const oDomains = overallCounts.get(category)!
        oDomains.set(domain, (oDomains.get(domain) ?? 0) + 1)

        // Per-query
        if (!qCounts.has(category)) qCounts.set(category, new Map())
        const qDomains = qCounts.get(category)!
        qDomains.set(domain, (qDomains.get(domain) ?? 0) + 1)
      }

      if (sources.length > 0 && snap.query) {
        byQuery[snap.query] = buildCategoryCounts(qCounts)
      }
    }

    const overall = buildCategoryCounts(overallCounts)

    return reply.send({ overall, byQuery, runId: latestRunId, window } satisfies SourceBreakdownDto)
  })
}

// --- Helpers ---


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
  const parsed = parseJsonColumn<Record<string, unknown>>(rawResponse, {})
  const sources = parsed.groundingSources as Array<{ uri?: string; title?: string }> | undefined
  if (!Array.isArray(sources)) return []
  return sources.filter(
    (s): s is { uri: string; title: string } =>
      typeof s.uri === 'string' && !isProviderInfraDomain(s.uri),
  )
}

function bucketSizeForSpan(spanDays: number): number {
  // Pick a bucket size based on how many days of data actually exist
  if (spanDays <= 14) return 1   // daily
  if (spanDays <= 60) return 7   // weekly
  if (spanDays <= 180) return 14 // bi-weekly
  return 30                       // monthly
}

interface SnapshotLike {
  queryId: string
  citationState: string
  resolvedMentioned: boolean
  createdAt: string
}

function computeProviderMetric(snapshots: SnapshotLike[]): ProviderMetric {
  const total = snapshots.length
  const cited = snapshots.filter(s => s.citationState === CitationStates.cited).length
  const mentionedCount = snapshots.filter(s => s.resolvedMentioned).length
  return {
    citationRate: total > 0 ? Math.round((cited / total) * 10000) / 10000 : 0,
    cited,
    total,
    mentionRate: total > 0 ? Math.round((mentionedCount / total) * 10000) / 10000 : 0,
    mentionedCount,
  }
}

function computeBuckets(
  snapshots: SnapshotLike[],
  projectRuns: Array<{ createdAt: string }>,
  bucketDays: number,
  queryCreatedAt?: Map<string, string>,
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

    // Only emit buckets that contain actual sweep data
    if (inBucket.length > 0) {
      // Normalize: only include queries that existed before this bucket started
      let usable = inBucket
      if (queryCreatedAt) {
        const eligible = inBucket.filter(s => {
          const qCreated = queryCreatedAt.get(s.queryId)
          return qCreated !== undefined && qCreated < startISO
        })
        // Fallback: if ALL queries are new (e.g. first bucket), use full set
        if (eligible.length > 0) usable = eligible
      }

      const metric = computeProviderMetric(usable)
      const queryCount = new Set(usable.map(s => s.queryId)).size
      buckets.push({
        startDate: startISO,
        endDate: endISO,
        citationRate: metric.citationRate,
        cited: metric.cited,
        total: metric.total,
        queryCount,
        mentionRate: metric.mentionRate,
        mentionedCount: metric.mentionedCount,
      })
    }

    start = end
  }

  return buckets
}

function computeQueryChanges(
  projectQueries: Array<{ id: string; createdAt: string }>,
  cutoff: string | null,
): QueryChangeEvent[] {
  // Group queries by creation day (YYYY-MM-DD)
  const byDay = new Map<string, number>()
  for (const q of projectQueries) {
    if (cutoff && q.createdAt < cutoff) continue
    const day = q.createdAt.slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }

  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  // First day is the baseline set, not a "change"
  if (days.length <= 1) return []

  return days.slice(1).map(([date, count]) => ({
    date: new Date(date + 'T00:00:00.000Z').toISOString(),
    delta: count,
    label: `+${count} kp`,
  }))
}

function computeTrend(buckets: TimeBucket[], rateKey: 'citationRate' | 'mentionRate'): TrendDirection {
  const nonEmpty = buckets.filter(b => b.total > 0)
  if (nonEmpty.length < 2) return 'stable'

  const mid = Math.floor(nonEmpty.length / 2)
  const firstHalf = nonEmpty.slice(0, mid)
  const secondHalf = nonEmpty.slice(mid)

  const avgFirst = firstHalf.reduce((s, b) => s + b[rateKey], 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((s, b) => s + b[rateKey], 0) / secondHalf.length

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
