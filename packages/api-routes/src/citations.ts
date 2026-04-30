import { eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { competitors, keywords, querySnapshots, runs, parseJsonColumn } from '@ainyc/canonry-db'
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
  keywordId: string
  provider: string
  citationState: string
  citedDomains: string
  competitorOverlap: string
  createdAt: string
  runCreatedAt: string
}

export async function citationRoutes(app: FastifyInstance) {
  // GET /projects/:name/citations/visibility
  // Single-call read: returns project headline + per-keyword coverage + competitor gaps
  // computed from the latest snapshot per (keyword × provider).
  app.get<{
    Params: { name: string }
  }>('/projects/:name/citations/visibility', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const configuredProviders = parseJsonColumn<string[]>(project.providers, [])

    const projectKeywords = app.db
      .select()
      .from(keywords)
      .where(eq(keywords.projectId, project.id))
      .all()

    if (projectKeywords.length === 0) {
      return reply.send(emptyCitationVisibility('no-keywords'))
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
        keywordId: querySnapshots.keywordId,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        citedDomains: querySnapshots.citedDomains,
        competitorOverlap: querySnapshots.competitorOverlap,
        createdAt: querySnapshots.createdAt,
      })
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, projectRuns.map(r => r.id)))
      .all()

    if (rawSnapshots.length === 0) {
      return reply.send(emptyCitationVisibility('no-runs-yet'))
    }

    const snapshots: SnapshotRow[] = rawSnapshots.map(s => ({
      ...s,
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
      keywords: projectKeywords.map(k => ({ id: k.id, keyword: k.keyword })),
      snapshots,
      configuredProviders,
      competitorDomains: projectCompetitors,
    })

    return reply.send(response)
  })
}

interface ComputeInput {
  keywords: Array<{ id: string; keyword: string }>
  snapshots: SnapshotRow[]
  configuredProviders: string[]
  competitorDomains: string[]
}

export function computeCitationVisibility(input: ComputeInput): CitationVisibilityResponse {
  const { keywords: kws, snapshots, configuredProviders, competitorDomains } = input

  // Latest snapshot per (keywordId × provider). Multi-provider runs put all
  // providers on the same run; single-provider runs leave older snapshots from
  // other providers as the latest available data point. Picking the freshest
  // record per pair gives the user a "latest known coverage" view rather than
  // gating on a single comprehensive run.
  const latestByPair = new Map<string, SnapshotRow>()
  for (const snap of snapshots) {
    const key = `${snap.keywordId}::${snap.provider}`
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

  // byKeyword — every project keyword gets a row, even ones with no snapshots
  // yet. Providers within a row are sorted by the configured order so the UI
  // can render columns deterministically.
  const byKeyword: CitationCoverageRow[] = []
  const providersCitingTracker = new Set<string>()
  let keywordsCited = 0
  let keywordsFullyCovered = 0
  let keywordsUncovered = 0

  for (const kw of kws) {
    const providers: CitationCoverageProvider[] = []
    let citedCount = 0

    for (const provider of providerUniverse) {
      const snap = latestByPair.get(`${kw.id}::${provider}`)
      if (!snap) continue
      const state = snap.citationState as CitationState
      const cited = citationStateToCited(state)
      if (cited) {
        citedCount++
        providersCitingTracker.add(provider)
      }
      providers.push({
        provider,
        citationState: state,
        cited,
        runId: snap.runId,
        runCreatedAt: snap.runCreatedAt,
      })
    }

    if (citedCount > 0) keywordsCited++
    // Fully covered = cited by every configured provider. A keyword missing
    // a snapshot for any provider in providerUniverse is not yet fully covered,
    // even if every observed provider cites it.
    if (providerUniverse.length > 0 && citedCount === providerUniverse.length) keywordsFullyCovered++
    if (providers.length > 0 && citedCount === 0) keywordsUncovered++

    byKeyword.push({
      keywordId: kw.id,
      keyword: kw.keyword,
      providers,
      citedCount,
      totalProviders: providers.length,
    })
  }

  // Competitor gaps: latest not-cited snapshot per (keyword × provider) where
  // a configured competitor appears in cited domains. Each row is one
  // (keyword, provider, competitor-set) tuple — a single keyword can show up
  // multiple times if multiple providers have the gap.
  const competitorSet = new Set(competitorDomains)
  const competitorGaps: CompetitorGapRow[] = []
  const keywordById = new Map(kws.map(k => [k.id, k.keyword]))

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
      keywordId: snap.keywordId,
      keyword: keywordById.get(snap.keywordId) ?? '',
      provider: snap.provider,
      citingCompetitors: citingCompetitors.sort(),
      runId: snap.runId,
      runCreatedAt: snap.runCreatedAt,
    })
  }
  competitorGaps.sort((a, b) => {
    if (a.keyword !== b.keyword) return a.keyword.localeCompare(b.keyword)
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
    totalKeywords: kws.length,
    keywordsCited,
    keywordsFullyCovered,
    keywordsUncovered,
    latestRunId,
    latestRunAt,
  }

  return {
    summary,
    byKeyword,
    competitorGaps,
    status: 'ready',
  }
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}
