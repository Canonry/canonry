import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  competitorSuggestionsQuerySchema,
  CompetitorSuggestionStatuses,
  COMPETITOR_SUGGESTION_COUNT_UNITS,
  competitorAliasProjectIdentity,
  competitorIdentityAliases,
  hostOf,
  normalizeCompetitorDomain,
  parseWindow,
  surfaceClassFromCompetitorType,
  type CompetitorSuggestionsResponse,
  validationError,
} from '@ainyc/canonry-contracts'
import { domainClassifications } from '@ainyc/canonry-db'
import { buildCompetitorSuggestions, type CompetitorLandscapeSurfaceClass } from '@ainyc/canonry-intelligence'
import { claimedCompetitorAdds, readStoredCompetitors } from './competitor-writes.js'
import { readMarketCompetitorPins } from './plan-competitors.js'
import { readMarketCompetitorNames } from './market-competitor-names.js'
import { resolveProject } from './helpers.js'
import { projectQueryClassifier } from './mention-share-inputs.js'
import { selectLandscapePinnedIdentities, selectLandscapePopulation } from './competitor-landscape.js'
import { activeMeasurementPlan } from './measurement-overview.js'

type RawQuery = {
  window?: string
  minAnswers?: string | number
  queryClass?: string
  groupKey?: string
  limit?: string | number
}

/** Stored-evidence candidate suggestions. This route never calls a provider or classifier. */
export async function competitorSuggestionRoutes(app: FastifyInstance) {
  app.get<{
    Params: { name: string }
    Querystring: RawQuery
  }>('/projects/:name/competitor-suggestions', async request => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = competitorSuggestionsQuerySchema.safeParse({ ...request.query, ...(request.query.window !== undefined ? { window: parseWindow(request.query.window) } : {}) })
    if (!parsed.success) throw validationError('Invalid competitor suggestion query', { issues: parsed.error.issues })
    const filters = parsed.data
    const window = parseWindow(filters.window ?? '30d')
    const minAnswers = filters.minAnswers ?? 3
    const limit = filters.limit ?? 25
    const classifier = projectQueryClassifier(project)
    const activeV2 = activeMeasurementPlan(app.db, project.id)?.plan.schemaVersion === 2
    const queryClass = filters.queryClass ?? (classifier || activeV2 ? 'non-brand' : 'all')
    if (queryClass !== 'all' && !classifier && !activeV2) {
      throw validationError(`Query class "${queryClass}" needs a brand name or alias on this project. Add one, or omit queryClass for a pooled landscape.`)
    }
    const advancedScope = filters.groupKey ? undefined
      : activeV2
        ? 'all-markets'
        : undefined
    const population = selectLandscapePopulation(app, request.params.name, {
      window,
      queryClass,
      ...(filters.groupKey ? { groupKey: filters.groupKey } : {}),
      ...(advancedScope ? { scope: advancedScope } : {}),
    })
    const {
      advanced,
      eligibleSnapshots: answers,
      excludedProbeResults,
      excludedNonCompletedResults,
    } = population
    const stored = readStoredCompetitors(app.db, project.id)
    const storedTracked = stored.map(row => ({
      domain: row.domain,
      aliases: competitorIdentityAliases(row),
      autoAliases: row.autoAliases,
      blockedAliases: row.blockedAliases,
    }))
    const pins = readMarketCompetitorPins(app.db, project.id)
    const marketNames = readMarketCompetitorNames(app.db, project.id)
    const trackedByDomain = new Map<string, { domain: string; aliases: string[] }>()
    for (const competitor of storedTracked) trackedByDomain.set(competitor.domain, { domain: competitor.domain, aliases: [...competitor.aliases] })
    for (const pin of pins) {
      const existing = trackedByDomain.get(pin.domain)
      if (existing) existing.aliases = [...new Set([...existing.aliases, ...pin.names])]
      else trackedByDomain.set(pin.domain, { domain: pin.domain, aliases: [...pin.names] })
    }
    const tracked = [...trackedByDomain.values()]
    const pooledPins = selectLandscapePinnedIdentities(
      advanced,
      storedTracked.map(row => ({
        domain: row.domain,
        label: row.domain,
        labelSource: 'domain' as const,
        aliases: [...row.aliases],
      })),
      advanced ? marketNames : new Map(),
    )
    const identitiesByRun = new Map<string, Array<{ domain: string; aliases: string[] }>>()
    const scopedAnswers = answers.map(answer => {
      let identities = identitiesByRun.get(answer.runId)
      if (!identities) {
        const byDomain = new Map<string, { domain: string; aliases: string[] }>()
        // Current pins reinterpret the selected history. Frozen pins add only
        // the names available in this run's selected market or pooled scope.
        // Use the same union as the landscape, including aliases on a domain
        // already present in the current pin set.
        for (const pin of [...pooledPins, ...(advanced?.runScopes.get(answer.runId)?.competitors ?? [])]) {
          const domain = normalizeCompetitorDomain(pin.domain)
          const existing = byDomain.get(domain)
          const aliases = [
            ...(existing?.aliases ?? []),
            ...(pin.labelSource === 'domain' ? [] : [pin.label]),
            ...pin.aliases,
          ]
          byDomain.set(domain, { domain, aliases: [...new Set(aliases)] })
        }
        identities = [...byDomain.values()]
        identitiesByRun.set(answer.runId, identities)
      }
      return { ...answer, competitors: identities }
    })
    const claimed = claimedCompetitorAdds(
      stored,
      scopedAnswers.flatMap(answer => [...answer.citedDomains, ...(answer.citedUrls ?? [])]),
      competitorAliasProjectIdentity(project),
      pins,
    )
    const classifications = new Map<string, CompetitorLandscapeSurfaceClass>()
    for (const row of app.db.select({ domain: domainClassifications.domain, type: domainClassifications.competitorType })
      .from(domainClassifications).where(eq(domainClassifications.projectId, project.id)).all()) {
      const domain = hostOf(row.domain)
      if (!domain) continue
      const surfaceClass = surfaceClassFromCompetitorType(row.type)
      classifications.set(domain, surfaceClass === 'own' ? 'unknown' : surfaceClass ?? 'unknown')
    }
    const built = buildCompetitorSuggestions({
      project: { domain: project.canonicalDomain, label: project.displayName ?? project.name, domains: project.ownedDomains },
      answers: scopedAnswers,
      minAnswers,
      classifications,
      tracked,
      claimedCompetitorAdds: new Set(claimed.keys()),
      marketKeys: new Map(pins.map(pin => [pin.domain, pin.markets] as const)),
    })
    const candidates = built.candidates.sort((left, right) => (
      (left.status === CompetitorSuggestionStatuses.suggested ? 0 : left.status === CompetitorSuggestionStatuses.tracked ? 1 : 2)
      - (right.status === CompetitorSuggestionStatuses.suggested ? 0 : right.status === CompetitorSuggestionStatuses.tracked ? 1 : 2)
      || right.namingAnswers - left.namingAnswers
      || left.domain.localeCompare(right.domain)
    ))
    const excludedCounts: Record<string, number> = {}
    for (const candidate of candidates) if (candidate.reason) excludedCounts[candidate.reason] = (excludedCounts[candidate.reason] ?? 0) + 1
    const response: CompetitorSuggestionsResponse = {
      project: project.name,
      window,
      scope: advanced?.kind === 'group'
        ? { kind: 'group', groupKey: advanced.groupKey! }
        : advanced?.kind === 'all-markets' ? { kind: 'all-markets' } : { kind: 'project' },
      filters: { queryClass, groupKey: filters.groupKey ?? null, limit, minAnswers },
      thresholds: { minAnswers },
      candidates: candidates.slice(0, limit),
      candidatesTotal: candidates.length,
      excludedCounts,
      unresolvedNames: built.unresolvedNames,
      evidence: {
        answeredResults: built.answeredResults,
        sourceResults: built.sourceResults,
        excludedProbeResults,
        excludedNonCompletedResults,
      },
      runCount: new Set(answers.map(answer => answer.runId)).size,
      runIds: [...new Set(answers.map(answer => answer.runId))],
      countUnits: COMPETITOR_SUGGESTION_COUNT_UNITS,
      truncated: candidates.length > limit,
    }
    return response
  })
}
