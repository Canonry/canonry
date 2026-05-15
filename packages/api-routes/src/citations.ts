import { eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { competitors, queries, querySnapshots, runs, parseJsonColumn } from '@ainyc/canonry-db'
import {
  emptyCitationVisibility,
  citationStateToCited,
  type CitationCoverageProvider,
  type CitationCoverageRow,
  type CitationVisibilityResponse,
  type CitationVisibilitySummary,
  type CompetitorGapRow,
  type CitationState,
} from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

interface SnapshotRow {
  id: string
  runId: string
  queryId: string
  provider: string
  citationState: string
  citedDomains: string
  competitorOverlap: string
  answerMentioned: boolean | null
  createdAt: string
  runCreatedAt: string
}

export async function citationRoutes(app: FastifyInstance) {
  // GET /projects/:name/citations/visibility
  // Single-call read: returns project headline + per-query coverage + competitor gaps
  // computed from the latest snapshot per (query × provider).
  app.get<{
    Params: { name: string }
  }>('/projects/:name/citations/visibility', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const configuredProviders = parseJsonColumn<string[]>(project.providers, [])

    const projectQueries = app.db
      .select()
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()

    if (projectQueries.length === 0) {
      return reply.send(emptyCitationVisibility('no-queries'))
    }

    const projectRuns = app.db
      .select({ id: runs.id, createdAt: runs.createdAt })
      .from(runs)
      .where(eq(runs.projectId, project.id))
      .all()

    if (projectRuns.length === 0) {
      return reply.send(emptyCitationVisibility('no-runs-yet'))
    }

    const runCreatedAt = new Map(projectRuns.map(r => [r.id, r.createdAt]))

    const rawSnapshots = app.db
      .select({
        id: querySnapshots.id,
        runId: querySnapshots.runId,
        queryId: querySnapshots.queryId,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        citedDomains: querySnapshots.citedDomains,
        competitorOverlap: querySnapshots.competitorOverlap,
        answerMentioned: querySnapshots.answerMentioned,
        createdAt: querySnapshots.createdAt,
      })
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, projectRuns.map(r => r.id)))
      .all()

    if (rawSnapshots.length === 0) {
      return reply.send(emptyCitationVisibility('no-runs-yet'))
    }

    // Skip orphan snapshots (query_id NULL because the tracked query was
    // deleted post-v58). `byQuery` groups by query; an orphan would collide
    // with every other orphan under a null key.
    const snapshots: SnapshotRow[] = rawSnapshots
      .filter(s => s.queryId !== null)
      .map(s => ({
        ...s,
        queryId: s.queryId as string,
        runCreatedAt: runCreatedAt.get(s.runId) ?? s.createdAt,
      }))

    const projectCompetitors = app.db
      .select({ domain: competitors.domain })
      .from(competitors)
      .where(eq(competitors.projectId, project.id))
      .all()
      .map(c => normalizeDomain(c.domain))
      .filter(d => d.length > 0)

    const response = computeCitationVisibility({
      queries: projectQueries.map(q => ({ id: q.id, query: q.query })),
      snapshots,
      configuredProviders,
      competitorDomains: projectCompetitors,
    })

    return reply.send(response)
  })
}

interface ComputeInput {
  queries: Array<{ id: string; query: string }>
  snapshots: SnapshotRow[]
  configuredProviders: string[]
  competitorDomains: string[]
}

export function computeCitationVisibility(input: ComputeInput): CitationVisibilityResponse {
  const { queries: qs, snapshots, configuredProviders, competitorDomains } = input

  // Latest snapshot per (queryId × provider). Multi-provider runs put all
  // providers on the same run; single-provider runs leave older snapshots from
  // other providers as the latest available data point. Picking the freshest
  // record per pair gives the user a "latest known coverage" view rather than
  // gating on a single comprehensive run.
  const latestByPair = new Map<string, SnapshotRow>()
  for (const snap of snapshots) {
    const key = `${snap.queryId}::${snap.provider}`
    const existing = latestByPair.get(key)
    if (!existing || snap.createdAt > existing.createdAt) {
      latestByPair.set(key, snap)
    }
  }

  // Set of providers we've actually observed in snapshots — falls back to this
  // when project.providers is empty (a project may have legacy runs against
  // providers it no longer lists in its config).
  const observedProviders = new Set<string>()
  for (const pair of latestByPair.values()) observedProviders.add(pair.provider)

  // The denominator for "X of N engines" is the configured set if non-empty,
  // otherwise the observed set so the metric is never 0/0.
  const providerUniverse = configuredProviders.length > 0
    ? Array.from(new Set(configuredProviders))
    : Array.from(observedProviders).sort()

  const providersCitingTracker = new Set<string>()
  const providersMentioningTracker = new Set<string>()

  // Cross-tab buckets at the query level. A query lands in exactly one
  // bucket: cited+mentioned > cited-only > mentioned-only > invisible.
  // Queries with zero snapshots fall through and are not counted in any
  // bucket — total - sum(buckets) = "no data yet".
  let queriesCitedAndMentioned = 0
  let queriesCitedOnly = 0
  let queriesMentionedOnly = 0
  let queriesInvisible = 0

  const byQuery: CitationCoverageRow[] = []

  for (const q of qs) {
    const providers: CitationCoverageProvider[] = []
    let citedCount = 0
    let mentionedCount = 0

    for (const provider of providerUniverse) {
      const snap = latestByPair.get(`${q.id}::${provider}`)
      if (!snap) continue
      const state = snap.citationState as CitationState
      const cited = citationStateToCited(state)
      // null answer_mentioned (legacy snapshot before the column existed) is
      // treated as "not mentioned" — we only credit explicit positives.
      const mentioned = snap.answerMentioned === true
      if (cited) {
        citedCount++
        providersCitingTracker.add(provider)
      }
      if (mentioned) {
        mentionedCount++
        providersMentioningTracker.add(provider)
      }
      providers.push({
        provider,
        citationState: state,
        cited,
        mentioned,
        runId: snap.runId,
        runCreatedAt: snap.runCreatedAt,
      })
    }

    if (providers.length > 0) {
      const anyCited = citedCount > 0
      const anyMentioned = mentionedCount > 0
      if (anyCited && anyMentioned) queriesCitedAndMentioned++
      else if (anyCited) queriesCitedOnly++
      else if (anyMentioned) queriesMentionedOnly++
      else queriesInvisible++
    }

    byQuery.push({
      queryId: q.id,
      query: q.query,
      providers,
      citedCount,
      mentionedCount,
      totalProviders: providers.length,
    })
  }

  // Competitor gaps: latest not-cited snapshot per (query × provider) where
  // a configured competitor appears in cited domains. Each row is one
  // (query, provider, competitor-set) tuple — a single query can show up
  // multiple times if multiple providers have the gap.
  const competitorSet = new Set(competitorDomains)
  const competitorGaps: CompetitorGapRow[] = []
  const queryById = new Map(qs.map(q => [q.id, q.query]))

  for (const snap of latestByPair.values()) {
    if (citationStateToCited(snap.citationState as CitationState)) continue
    if (competitorSet.size === 0) continue
    const cited = parseJsonColumn<string[]>(snap.citedDomains, [])
    const overlap = parseJsonColumn<string[]>(snap.competitorOverlap, [])
    // Some normalizers populate competitorOverlap directly; others only
    // populate citedDomains. Use either source for resilience.
    const candidates = new Set(
      [...cited, ...overlap].map(d => normalizeDomain(d)).filter(d => d.length > 0),
    )
    const citingCompetitors = Array.from(candidates).filter(d => competitorSet.has(d))
    if (citingCompetitors.length === 0) continue

    competitorGaps.push({
      queryId: snap.queryId,
      query: queryById.get(snap.queryId) ?? '',
      provider: snap.provider,
      citingCompetitors: citingCompetitors.sort(),
      runId: snap.runId,
      runCreatedAt: snap.runCreatedAt,
    })
  }
  competitorGaps.sort((a, b) => {
    if (a.query !== b.query) return a.query.localeCompare(b.query)
    return a.provider.localeCompare(b.provider)
  })

  // Latest run across all snapshots — used by the UI for "as of <timestamp>"
  let latestRunId: string | null = null
  let latestRunAt: string | null = null
  for (const snap of latestByPair.values()) {
    if (latestRunAt === null || snap.runCreatedAt > latestRunAt) {
      latestRunAt = snap.runCreatedAt
      latestRunId = snap.runId
    }
  }

  const summary: CitationVisibilitySummary = {
    providersConfigured: providerUniverse.length,
    providersCiting: providersCitingTracker.size,
    providersMentioning: providersMentioningTracker.size,
    totalQueries: qs.length,
    queriesCitedAndMentioned,
    queriesCitedOnly,
    queriesMentionedOnly,
    queriesInvisible,
    latestRunId,
    latestRunAt,
  }

  return {
    summary,
    byQuery,
    competitorGaps,
    status: 'ready',
  }
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}
