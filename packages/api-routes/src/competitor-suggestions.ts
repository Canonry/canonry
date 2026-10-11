import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  competitorSuggestionsQuerySchema,
  COMPETITOR_SUGGESTION_COUNT_UNITS,
  competitorAliasProjectIdentity,
  competitorIdentityAliases,
  hostOf,
  parseWindow,
  surfaceClassFromCompetitorType,
  type CompetitorSuggestionsResponse,
  validationError,
} from '@ainyc/canonry-contracts'
import { domainClassifications } from '@ainyc/canonry-db'
import { buildCompetitorSuggestions } from '@ainyc/canonry-intelligence'
import { claimedCompetitorAdds, readStoredCompetitors } from './competitor-writes.js'
import { readMarketCompetitorPins } from './plan-competitors.js'
import { resolveProject } from './helpers.js'
import { projectQueryClassifier } from './mention-share-inputs.js'
import { selectLandscapePopulation } from './competitor-landscape.js'
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
    const parsed = competitorSuggestionsQuerySchema.safeParse(request.query)
    if (!parsed.success) throw validationError('Invalid competitor suggestion query', { issues: parsed.error.issues })
    const filters = parsed.data
    const window = parseWindow(filters.window ?? '30d')
    const minAnswers = filters.minAnswers ?? 3
    const limit = filters.limit ?? 25
    const classifier = projectQueryClassifier(project)
    const queryClass = filters.queryClass ?? (classifier ? 'non-brand' : 'all')
    if (queryClass !== 'all' && !classifier) {
      throw validationError(`Query class "${queryClass}" needs a brand name or alias on this project. Add one, or omit queryClass for a pooled landscape.`)
    }
    const advancedScope = filters.groupKey ? undefined
      : activeMeasurementPlan(app.db, project.id)?.plan.schemaVersion === 2 && queryClass !== 'all'
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
    const tracked = stored.map(row => ({
      domain: row.domain,
      aliases: competitorIdentityAliases(row),
      autoAliases: row.autoAliases,
      blockedAliases: row.blockedAliases,
    }))
    const pins = readMarketCompetitorPins(app.db, project.id)
    const claimed = claimedCompetitorAdds(
      stored,
      answers.flatMap(answer => [...answer.citedDomains, ...(answer.citedUrls ?? [])]),
      competitorAliasProjectIdentity(project),
      pins,
    )
    const classifications = new Map<string, 'own' | 'direct-competitor' | 'ota-aggregator' | 'editorial-media' | 'other' | 'unknown'>()
    for (const row of app.db.select({ domain: domainClassifications.domain, type: domainClassifications.competitorType })
      .from(domainClassifications).where(eq(domainClassifications.projectId, project.id)).all()) {
      const domain = hostOf(row.domain)
      if (!domain) continue
      classifications.set(domain, surfaceClassFromCompetitorType(row.type) ?? 'unknown')
    }
    const built = buildCompetitorSuggestions({
      project: { domain: project.canonicalDomain, label: project.displayName ?? project.name, domains: project.ownedDomains },
      answers,
      minAnswers,
      classifications,
      tracked,
      claimedCompetitorAdds: new Set(claimed.keys()),
      marketKeys: new Map(pins.map(pin => [pin.domain, pin.markets] as const)),
    })
    const candidates = built.candidates.sort((left, right) => (
      (left.status === 'suggested' ? 0 : left.status === 'tracked' ? 1 : 2)
      - (right.status === 'suggested' ? 0 : right.status === 'tracked' ? 1 : 2)
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
