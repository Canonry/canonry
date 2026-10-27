import crypto from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SeoRepository, competitors, currentSeoTaskCondition, currentSeoTasks, projects, queries, runs, seoJobs, seoProfiles, seoTasks, type DatabaseClient, type SeoJobRow, type SeoTaskRow } from '@canonry/canonry-db'
import {
  AppError, RunKinds, RunStatuses, RunTriggers, SEO_MARKET_RANKING_MAX_SEARCHES, SEO_PROJECT_MARKET_KEY, SEO_RUN_SCOPE, SEO_WRITE_SCOPE, SeoAdapterOutcomes, SeoAvailability, SeoCapabilities, SeoKeywordGapKinds, SeoKeywordGapModes, SeoMarketRankingSearchStatuses, SeoMarketRankingSorts, SeoRunStatuses, SeoScopeKinds, SeoTargetKinds, UserRoles,
  compareSeoCompetitorsBy, compareSeoKeywordGapsBy, compareMarketRankingsBy, compareText, countMarketRankings, effectiveDomains, groupMarketRankings, marketRankingRow, matchesMarketRankingFilter, matchesMarketRankingText, matchesMeasurementTargetUrl, normalizeHostname, missingDependency, notFound, queryClassSchema, registrableDomain, seoSearchTextForQuery, validationError,
  seoProfileInputSchema, seoSyncInputSchema, seoRefreshIntentInputSchema, seoEvidenceQuerySchema, seoCompetitorQuerySchema, seoKeywordGapQuerySchema, seoMarketRankingQuerySchema, seoMarketRankingSummaryQuerySchema, seoReconcileInputSchema,
  type MeasurementPlanV2, type SeoAdapter, type SeoAdapterRequest, type SeoCapability, type SeoCompetitorList, type SeoCompetitorQuery, type SeoContext, type SeoEvidenceQuery, type SeoKeywordGapList, type SeoKeywordGapQuery, type SeoMarketRanking, type SeoMarketRankingContext, type SeoMarketRankingList, type SeoMarketRankingQuery, type SeoMarketRankingSearchMarket, type SeoMarketRankingSummary, type SeoMarketRankingSummaryQuery, type SeoOverview, type SeoProfile, type SeoProfileInput, type SeoQuote, type SeoResults, type SeoRun, type SeoRunDetail, type SeoRunStatus, type SeoScopeSelection, type SeoStatus, type SeoOperatorTask, type SeoReconcileResult,
} from '@canonry/canonry-contracts'
import { requireAdminSession, requireScope, requireOperator } from './auth.js'
import { resolveProject, writeAuditLog } from './helpers.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import { planScopeOptions } from './measurement-scope-options.js'
import { createPlanPinLookup } from './plan-competitors.js'
import { readQueryClasses } from './query-class-read.js'

export interface SeoConnection { id: string; label: string; adapter: SeoAdapter }
export interface SeoPolicy { maxRunCostMicros: number; accountDailyLimitMicros: number; accountMonthlyLimitMicros: number; projectMonthlyLimitMicros: number }
export interface SeoRoutesOptions {
  /** Local configuration and cached prices only. Never performs provider I/O. */
  getSeoRuntime?: () => { connections: SeoConnection[]; policy: SeoPolicy } | null
  onSeoRunRequested?: (runId: string) => void
}
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
const actor = (request: FastifyRequest) => request.principal?.delegatedUser?.id ?? request.principal?.id ?? request.apiKey?.id ?? 'local'
function can(request: FastifyRequest, scope: string): boolean {
  const principal = request.principal
  const role = principal?.kind === 'user' ? principal.role : principal?.delegatedUser?.role
  if (role === UserRoles.viewer) return false
  const scopes = principal?.scopes ?? request.apiKey?.scopes
  return !scopes || scopes.includes('*') || scopes.includes(scope)
}
function profileDto(row: typeof seoProfiles.$inferSelect): SeoProfile {
  return { ...row.input, id: row.id, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt }
}
function runDto(job: SeoJobRow, counts: Array<{ status: SeoRunStatus; count: number }>): SeoRun {
  return { id: job.id, projectId: job.projectKey, profileId: job.profileId, profileRevision: job.profileRevision, locationCode: job.profile.locationCode, languageCode: job.profile.languageCode, cancelRequested: job.cancelRequested, status: job.status, capabilities: job.profile.capabilities, scope: job.profile.scope, taskCount: counts.reduce((sum, group) => sum + group.count, 0), completedTasks: counts.filter(group => group.status === SeoRunStatuses.completed || group.status === SeoRunStatuses.partial).reduce((sum, group) => sum + group.count, 0), failedTasks: counts.filter(group => group.status === SeoRunStatuses.failed).reduce((sum, group) => sum + group.count, 0), createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error }
}
function resultRows(tasks: SeoTaskRow[]): SeoResults {
  // A task reconciled as failed contributes no evidence. A failed search still keeps its rows, saying so.
  const kept = tasks.filter(task => task.reconciliation?.outcome !== SeoAdapterOutcomes.failed)
  return {
    keywordMetrics: kept.flatMap(task => task.results.keywordMetrics),
    domainIntelligence: kept.flatMap(task => task.results.domainIntelligence),
    rankedKeywords: kept.flatMap(task => task.results.rankedKeywords),
    marketRankings: tasks.flatMap(marketRankingRows),
    competitors: kept.flatMap(task => task.results.competitors ?? []),
    keywordGaps: kept.flatMap(task => task.results.keywordGaps ?? []),
  }
}

/**
 * A market-rankings search's rows. A search with results stored one row per market it answers.
 * One that failed or never ran stored none, so it reads as the same rows saying so: without them
 * a market silently lists fewer queries. Rows saved before `searchStatus` existed were complete.
 */
function marketRankingRows(task: SeoTaskRow): SeoMarketRanking[] {
  const stored = task.reconciliation?.outcome === SeoAdapterOutcomes.failed ? [] : task.results.marketRankings ?? []
  if (stored.length > 0) return stored.map(row => ({ ...row, searchStatus: row.searchStatus ?? SeoMarketRankingSearchStatuses.completed }))
  const { search, target } = task.request
  if (task.request.capability !== SeoCapabilities['market-rankings'] || !search || !target) return []
  const searchStatus = task.status === SeoRunStatuses.cancelled ? SeoMarketRankingSearchStatuses.cancelled
    : task.status === SeoRunStatuses.failed || task.status === SeoRunStatuses['reconciliation-required'] ? SeoMarketRankingSearchStatuses.failed : null
  if (!searchStatus) return []
  return search.markets.map(market => ({
    ...market.context, searchText: task.request.keywords[0] ?? '', locationLabel: search.locationLabel, target, searchStatus,
    rankOrganic: null, rankAbsolute: null, url: null, depth: 0, competitors: [], provenance: null,
  }))
}

/** What a market-rankings task searched, so Activity can name a search that failed. */
function taskSearch(task: SeoTaskRow): { searchText: string | null; locationLabel: string | null } {
  return task.request.capability === SeoCapabilities['market-rankings']
    ? { searchText: task.request.keywords[0] ?? null, locationLabel: task.request.search?.locationLabel ?? null }
    : { searchText: null, locationLabel: null }
}

/** Market-rankings rows in reading order: region, market, then the searched text. */
function compareMarketRankings(a: SeoMarketRanking, b: SeoMarketRanking): number {
  return compareText(a.regionLabel ?? '', b.regionLabel ?? '') || compareText(a.marketLabel, b.marketLabel)
    || compareText(a.searchText, b.searchText) || compareText(a.queryText, b.queryText)
}

function scopedPlanTargets(plan: MeasurementPlanV2, scope: SeoScopeSelection) {
  const market = scope.kind === SeoScopeKinds.market ? plan.reportingScopes?.find(market => market.stableKey === scope.key) : undefined
  const targetKeys = scope.kind === SeoScopeKinds.project ? plan.targets.map(target => target.stableKey) : scope.kind === SeoScopeKinds.property ? [scope.key!] : scope.kind === SeoScopeKinds.group ? plan.groups.find(group => group.stableKey === scope.key)!.targetKeys : [...new Set(market!.usageEdges.map(edge => edge.targetKey))]
  return { targets: plan.targets.filter(target => targetKeys.includes(target.stableKey)), market, targetKeys }
}

function scopeCapabilities(kind: SeoScopeSelection['kind'], targets: MeasurementPlanV2['targets']): SeoCapability[] {
  if (kind === SeoScopeKinds.project) return Object.values(SeoCapabilities)
  const exactHosts = targets.length > 0 && targets.every(target => target.urlMatchers.length > 0 && target.urlMatchers.every(matcher => matcher.kind === 'host'))
  // Market rankings report where the project's site ranks for a market's tracked queries, so they follow
  // markets and groups; a single Property has no market of its own.
  const markets = kind === SeoScopeKinds.group || kind === SeoScopeKinds.market ? [SeoCapabilities['market-rankings']] : []
  return exactHosts ? [SeoCapabilities['keyword-metrics'], SeoCapabilities['ranked-keywords'], ...markets] : [SeoCapabilities['keyword-metrics'], ...markets]
}

/** What a non-project Advanced scope supports, in one sentence. */
function scopeReason(capabilities: SeoCapability[]): string {
  const markets = capabilities.includes(SeoCapabilities['market-rankings'])
  return capabilities.includes(SeoCapabilities['ranked-keywords'])
    ? `Supports explicit keyword metrics${markets ? ', market rankings' : ''} and exact-host ranked keywords. Use project scope for domain intelligence, competitor discovery and keyword gaps.`
    : `Supports explicit keyword metrics${markets ? ' and market rankings' : ' only'}. Use project scope for domain research; path and entity Properties cannot be replaced by whole-domain data.`
}

/** Both run surfaces share cancellation semantics and write one truthful audit receipt. */
export function cancelSeoRefresh(db: DatabaseClient, projectId: string, id: string): void {
  db.transaction(tx => {
    const changed = new SeoRepository(db).cancel(id)
    const current = tx.select({ status: seoJobs.status }).from(seoJobs).where(and(eq(seoJobs.id, id), eq(seoJobs.projectId, projectId), isNotNull(seoJobs.runId))).get()
    if (!current) throw notFound('SEO run', id)
    if (!changed && [SeoRunStatuses.completed, SeoRunStatuses.partial, SeoRunStatuses.failed, SeoRunStatuses.cancelled].some(status => status === current.status)) throw validationError('This SEO refresh has already finished.')
    if (changed) writeAuditLog(tx, { projectId, actor: 'api', action: 'seo.sync.cancelled', entityType: 'run', entityId: id })
  })
}

/** Frozen measurement context is lineage, never a denominator for vendor estimates. */
function resolveScope(db: DatabaseClient, projectId: string, input: SeoProfileInput): Record<string, unknown> {
  const active = activeMeasurementPlan(db, projectId)
  if (!active) {
    if (input.scope.kind !== SeoScopeKinds.project || input.scope.key || input.scope.expectedPlanRevision !== undefined) throw validationError('This project supports project SEO scope only.')
    return { mode: 'simple', scope: input.scope }
  }
  if (input.scope.expectedPlanRevision !== active.version.revision) throw validationError('Select the current Advanced Measurement revision before saving or refreshing this profile.')
  if (active.plan.schemaVersion !== 2) throw validationError('Publish a current Advanced Measurement plan before using scoped SEO profiles.')
  const plan = active.plan
  const option = planScopeOptions(plan, { marketLinks: true }).find(option => option.kind === input.scope.kind && (option.kind === SeoScopeKinds.project ? !input.scope.key : option.id === input.scope.key))
  if (!option) throw validationError('The selected SEO scope does not exist in this plan revision.')
  const { market, targetKeys, targets } = scopedPlanTargets(plan, input.scope)
  const supported = scopeCapabilities(input.scope.kind, targets)
  if (input.capabilities.some(capability => !supported.includes(capability))) {
    if (input.capabilities.includes(SeoCapabilities['competitor-discovery']) || input.capabilities.includes(SeoCapabilities['keyword-gaps'])) throw validationError('Competitor discovery and keyword gaps compare whole domains. Select project scope with an explicit domain Target; Property, group and market scope cannot be broadened automatically.')
    if (supported.includes(SeoCapabilities['ranked-keywords'])) throw validationError('Domain intelligence requires project scope with a whole-domain Target. This Advanced scope supports exact-host ranked keywords and explicit keyword metrics.')
    throw validationError('This Advanced scope contains path or entity Properties and supports explicit keyword metrics only. Select a host-only scope for ranked keywords, or project scope for whole-domain intelligence.')
  }
  if (input.scope.kind !== SeoScopeKinds.project && input.capabilities.includes(SeoCapabilities['ranked-keywords'])) {
    const matchers = targets.flatMap(target => target.urlMatchers).filter(matcher => matcher.kind === 'host')
    // Measurement host identity folds www; the provider request retains the exact selected hostname.
    if (input.targets.some(target => target.kind !== SeoTargetKinds.host || target.includeSubdomains || !matchers.some(matcher => matchesMeasurementTargetUrl(`https://${target.value}/`, matcher)))) throw validationError('Ranked keywords in this Advanced scope require an exact host Target belonging to a selected Property. Other hosts and broader domains are not supported.')
  }
  const assignments = plan.assignments.filter(assignment => targetKeys.includes(assignment.targetKey) && (!market || market.usageEdges.some(edge => edge.targetKey === assignment.targetKey && edge.queryId === assignment.queryId && edge.executionNodeKey === assignment.executionNodeKey)))
  return { mode: 'advanced', planRevision: active.version.revision, planVersionId: active.version.id, scope: input.scope, targets, assignments, market: market ?? null }
}

function normalizeProfile(input: SeoProfileInput): SeoProfileInput {
  if (new Set(input.capabilities).size !== input.capabilities.length) throw validationError('Select each SEO capability once.')
  const normalized = [...input.targets, ...(input.competitors ?? [])].map(target => {
    const host = normalizeHostname(target.value)
    if (!host) throw validationError('SEO Targets must be plain hostnames without paths or ports.')
    if (target.kind === SeoTargetKinds.host && target.includeSubdomains) throw validationError('Exact host Targets cannot include subdomains.')
    return { ...target, value: host }
  })
  const targets = normalized.slice(0, input.targets.length)
  const comparisonTargets = normalized.slice(input.targets.length)
  if (new Set(targets.map(target => `${target.kind}:${target.value}:${target.includeSubdomains}`)).size !== targets.length) throw validationError('SEO Targets must be distinct.')
  const competitive = input.capabilities.includes(SeoCapabilities['competitor-discovery']) || input.capabilities.includes(SeoCapabilities['keyword-gaps'])
  if (competitive && [...targets, ...comparisonTargets].some(target => target.kind !== SeoTargetKinds.domain || !target.includeSubdomains || registrableDomain(target.value) !== target.value)) throw validationError('Competitor discovery and keyword gaps require root domain Targets with subdomains included. Exact host comparisons are not supported by this source.')
  if (input.capabilities.includes(SeoCapabilities['keyword-gaps'])) {
    if (!comparisonTargets.length) throw validationError('Keyword gaps requires at least one explicit competitor domain.')
    if (new Set(comparisonTargets.map(target => target.value)).size !== comparisonTargets.length) throw validationError('Competitor domains must be distinct.')
    if (comparisonTargets.some(competitor => targets.some(target => target.value === competitor.value))) throw validationError('A keyword-gap competitor must differ from every Target domain.')
  } else if (input.competitors !== undefined) {
    throw validationError('Comparison competitors apply only to keyword gaps.')
  }
  const keywords = [...new Set(input.keywords)]
  if (input.capabilities.includes(SeoCapabilities['keyword-metrics']) && !keywords.length) throw validationError('Keyword metrics requires at least one explicit keyword.')
  if (input.capabilities.some(capability => capability !== SeoCapabilities['keyword-metrics']) && !targets.length) throw validationError('Domain capabilities require at least one explicit Target.')
  if (input.capabilities.includes(SeoCapabilities['market-rankings'])) {
    if (input.capabilities.length !== 1) throw validationError('Keep market rankings in their own profile: they run one search for each tracked query and market.')
    if (!input.rankings) throw validationError('Market rankings need search settings: market locations, result depth, device and search text.')
    if (targets.length !== 1) throw validationError('Market rankings need exactly one Target: the site whose position they report.')
    if (keywords.length) throw validationError('Market rankings search the project\'s tracked queries. Leave keywords empty.')
    const keys = input.rankings.locations.map(location => location.key)
    if (new Set(keys).size !== keys.length) throw validationError('Set each market location once.')
  } else if (input.rankings) {
    throw validationError('Search settings apply only to market rankings.')
  }
  return { ...input, targets, keywords, ...(input.competitors === undefined ? {} : { competitors: comparisonTargets }) }
}

/** One paid search a market-rankings refresh runs, and the markets and queries it answers. */
interface PlannedMarketSearch { searchText: string; locationCode: number; locationLabel: string; markets: SeoMarketRankingSearchMarket[] }
interface MarketRankingPlan { searches: PlannedMarketSearch[] }
const NO_MARKET_RANKINGS: MarketRankingPlan = { searches: [] }

/** A tracked query in one market. Advanced queries carry the execution nodes that ask them there, whose groups' pinned competitors apply. */
interface MarketQuery { id: string | null; text: string; executionNodeKeys: string[] }
interface MarketQueries { context: Omit<SeoMarketRankingContext, 'queryId' | 'queryText' | 'queryClass'>; locationKeys: string[]; queries: MarketQuery[] }

/** Advanced: each market in scope with its non-brand queries, region (top-level group) and location lookup order. */
function advancedMarketQueries(plan: MeasurementPlanV2, scope: SeoScopeSelection): MarketQueries[] {
  const groups = new Map(plan.groups.map(group => [group.stableKey, group]))
  const lineage = (groupKey: string | undefined): string[] => {
    const keys: string[] = []
    for (let key = groupKey; key && !keys.includes(key); key = groups.get(key)?.parentGroupKey) keys.push(key)
    return keys
  }
  const nonBrandEdge = new Set(plan.assignments.filter(assignment => assignment.queryClass === queryClassSchema.enum['non-brand']).map(assignment => `${assignment.targetKey}\u0000${assignment.queryId}`))
  const queryText = new Map(plan.querySnapshots.map(snapshot => [snapshot.queryId, snapshot.queryText]))
  // Each query once, in first-seen order, with every execution node that asks it in this market.
  const queriesFor = (edges: Iterable<{ queryId: string; executionNodeKey: string }>): MarketQuery[] => {
    const nodes = new Map<string, Set<string>>()
    for (const edge of edges) nodes.set(edge.queryId, (nodes.get(edge.queryId) ?? new Set<string>()).add(edge.executionNodeKey))
    return [...nodes].flatMap(([id, keys]) => { const text = queryText.get(id); return text ? [{ id, text, executionNodeKeys: [...keys] }] : [] })
  }
  const markets = plan.reportingScopes ?? []
  if (!markets.length) {
    // A plan without markets reads as one market: the whole project, or the selected group's Properties.
    const { targetKeys } = scopedPlanTargets(plan, scope)
    return [{ context: { marketKey: SEO_PROJECT_MARKET_KEY, marketLabel: 'Project', regionKey: null, regionLabel: null }, locationKeys: [SEO_PROJECT_MARKET_KEY], queries: queriesFor(plan.assignments.filter(assignment => targetKeys.includes(assignment.targetKey) && nonBrandEdge.has(`${assignment.targetKey}\u0000${assignment.queryId}`))) }]
  }
  return markets.flatMap(market => {
    const chain = lineage(market.groupKey)
    const inScope = scope.kind === SeoScopeKinds.project || (scope.kind === SeoScopeKinds.market ? market.stableKey === scope.key : scope.kind === SeoScopeKinds.group && chain.includes(scope.key!))
    if (!inScope) return []
    const region = chain.at(-1)
    return [{
      context: { marketKey: market.stableKey, marketLabel: market.label, regionKey: region ?? null, regionLabel: region ? groups.get(region)?.label ?? region : null },
      locationKeys: [market.stableKey, ...chain],
      queries: queriesFor(market.usageEdges.filter(edge => nonBrandEdge.has(`${edge.targetKey}\u0000${edge.queryId}`))),
    }]
  })
}

/** Simple: each configured location is a market (or the whole project), all asking the project's non-brand queries. */
function simpleMarketQueries(db: DatabaseClient, project: typeof projects.$inferSelect): MarketQueries[] {
  const rows = db.select({ id: queries.id, query: queries.query }).from(queries).where(eq(queries.projectId, project.id)).all()
  const classes = readQueryClasses(db, project, rows)
  if (rows.length > 0 && rows.every(row => classes.get(row.id) == null)) {
    throw validationError('Canonry cannot tell this project\'s branded queries apart without a brand name. Add one before setting up market rankings.')
  }
  const nonBrand = rows.filter(row => classes.get(row.id) === queryClassSchema.enum['non-brand']).map(row => ({ id: row.id, text: row.query, executionNodeKeys: [] }))
  const locations = project.locations.length > 0 ? project.locations.map(location => ({ key: location.label, label: location.label })) : [{ key: SEO_PROJECT_MARKET_KEY, label: 'Project' }]
  return locations.map(location => ({ context: { marketKey: location.key, marketLabel: location.label, regionKey: null, regionLabel: null }, locationKeys: [location.key], queries: nonBrand }))
}

/**
 * The searches one market-rankings refresh runs: every non-brand tracked query in each market of
 * the scope, searched from the market's location. A search text asked in two markets that share a
 * location runs once and answers both. Every market must resolve a location, through its own key,
 * its group and that group's parents (Advanced) or its location label (Simple); only the
 * whole-project market falls back to the profile's location. Each market's row reports the
 * competitors that query is tracked against: the project's, plus, in an Advanced plan, those pinned
 * to the groups whose Properties ask it (`createPlanPinLookup`, the scope its AI answers are scored
 * against), so a pin never shows up in another market's row.
 */
function marketRankingPlan(db: DatabaseClient, projectId: string, input: SeoProfileInput): MarketRankingPlan {
  if (!input.capabilities.includes(SeoCapabilities['market-rankings']) || !input.rankings) return NO_MARKET_RANKINGS
  const settings = input.rankings
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) throw notFound('Project', projectId)
  const own = new Set(effectiveDomains({ canonicalDomain: project.canonicalDomain, ownedDomains: project.ownedDomains }).map(domain => registrableDomain(domain)).filter(Boolean))
  const target = input.targets[0]
  if (!target || !own.has(registrableDomain(target.value))) throw validationError('The market-rankings Target must be one of this project\'s own domains.')
  const active = activeMeasurementPlan(db, projectId)
  const advanced = active?.plan.schemaVersion === 2 ? { versionId: active.version.id, plan: active.plan } : null
  const markets = advanced ? advancedMarketQueries(advanced.plan, input.scope) : simpleMarketQueries(db, project)
  // Registrable domains, as the results are read; the project's own domains are never a competitor.
  const rival = (domain: string) => { const registrable = registrableDomain(normalizeHostname(domain) ?? domain); return registrable && !own.has(registrable) ? [registrable] : [] }
  const projectCompetitors = db.select({ domain: competitors.domain }).from(competitors).where(eq(competitors.projectId, projectId)).all().flatMap(row => rival(row.domain))
  const pinnedFor = createPlanPinLookup(db)
  const competitorsFor = (query: MarketQuery) => [...new Set([...projectCompetitors, ...query.executionNodeKeys.flatMap(key => pinnedFor(advanced?.versionId, key)).flatMap(rival)])].sort(compareText)
  const locations = new Map(settings.locations.map(location => [location.key, location]))
  const searches = new Map<string, PlannedMarketSearch>()
  const unmapped: string[] = []
  for (const market of markets) {
    const mapped = market.locationKeys.map(key => locations.get(key)).find(location => location !== undefined)
    const location = mapped ?? (market.context.marketKey === SEO_PROJECT_MARKET_KEY ? { locationCode: input.locationCode, label: `Location ${input.locationCode}` } : undefined)
    if (!location) { unmapped.push(market.context.marketLabel); continue }
    for (const query of market.queries) {
      const searchText = seoSearchTextForQuery(query.text, market.context.marketKey === SEO_PROJECT_MARKET_KEY ? null : market.context.marketLabel, settings.searchText)
      if (!searchText) continue
      const answers: SeoMarketRankingSearchMarket = {
        context: { ...market.context, queryId: query.id, queryText: query.text, queryClass: queryClassSchema.enum['non-brand'] },
        competitors: competitorsFor(query),
      }
      const key = `${location.locationCode}\u0000${searchText.toLowerCase()}`
      const existing = searches.get(key)
      if (existing) existing.markets.push(answers)
      else searches.set(key, { searchText, locationCode: location.locationCode, locationLabel: location.label, markets: [answers] })
    }
  }
  if (unmapped.length) throw validationError(`Set a search location for ${unmapped.length === 1 ? '1 market' : `${unmapped.length} markets`} or their groups: ${unmapped.slice(0, 5).join('; ')}${unmapped.length > 5 ? '; …' : ''}.`)
  if (!searches.size) throw validationError('There are no non-brand tracked queries to search in this scope.')
  if (searches.size > SEO_MARKET_RANKING_MAX_SEARCHES) throw validationError(`One market-rankings refresh runs at most ${SEO_MARKET_RANKING_MAX_SEARCHES} searches; this scope needs ${searches.size}. Select a narrower scope.`)
  return { searches: [...searches.values()].sort((a, b) => compareText(a.locationLabel, b.locationLabel) || compareText(a.searchText, b.searchText)) }
}

function taskRequests(profile: SeoProfileInput, rankings: MarketRankingPlan): SeoAdapterRequest[] {
  return profile.capabilities.flatMap((capability): SeoAdapterRequest[] => {
    if (capability === SeoCapabilities['keyword-gaps']) {
      return profile.targets.flatMap(target => (profile.competitors ?? []).flatMap(competitor => Object.values(SeoKeywordGapModes).map(mode => ({
        capability, target, keywords: [], locationCode: profile.locationCode, languageCode: profile.languageCode, limit: profile.limit, tag: '', comparison: { competitor, mode },
      }))))
    }
    if (capability === SeoCapabilities['market-rankings']) {
      const settings = profile.rankings!
      return rankings.searches.map(search => ({
        capability, target: profile.targets[0]!, keywords: [search.searchText], locationCode: search.locationCode, languageCode: profile.languageCode, limit: profile.limit, tag: '',
        search: { device: settings.device, depth: settings.depth, locationLabel: search.locationLabel, markets: search.markets },
      }))
    }
    return (capability === SeoCapabilities['keyword-metrics'] ? [null] : profile.targets).map(target => ({ capability, target, keywords: capability === SeoCapabilities['keyword-metrics'] ? profile.keywords : [], locationCode: profile.locationCode, languageCode: profile.languageCode, limit: profile.limit, tag: '' }))
  })
}

/** Price a profile's bounded task set under the host policy. Local configuration only; no provider I/O. */
function planSeoTasks(opts: SeoRoutesOptions, input: SeoProfileInput, rankings: MarketRankingPlan = NO_MARKET_RANKINGS) {
  const runtime = opts.getSeoRuntime?.() ?? null
  const connection = runtime?.connections.find(connection => connection.id === input.connectionId)
  if (!runtime || !opts.onSeoRunRequested) throw missingDependency('SEO execution is not configured on this host.')
  if (!connection) throw validationError('This SEO connection is unavailable. Select a connection listed in SEO context.')
  if (input.capabilities.some(capability => !connection.adapter.capabilities.includes(capability))) throw validationError('The selected SEO connection does not support every requested capability. Select capabilities listed for this connection in SEO context.')
  let planned: Array<{ request: SeoAdapterRequest; reservedMicros: number; catalogRevision: string }>
  try { planned = taskRequests(input, rankings).map(request => { const estimate = connection.adapter.estimate(request); return { request, reservedMicros: estimate.maxCostMicros, catalogRevision: estimate.catalogRevision } }) } catch (error) {
    if (error instanceof AppError && error.code === 'VALIDATION_ERROR') throw error
    throw validationError('The SEO provider could not prepare this request. Check its input requirements or contact the host operator.')
  }
  const total = planned.reduce((sum, task) => sum + task.reservedMicros, 0)
  if (!planned.length || planned.some(task => !Number.isSafeInteger(task.reservedMicros) || task.reservedMicros <= 0) || !Number.isSafeInteger(total) || total > runtime.policy.maxRunCostMicros) throw validationError('SEO refresh is unavailable under the current policy.')
  const intentHash = hash(JSON.stringify({ provider: connection.adapter.provider, account: connection.adapter.accountKey, policy: runtime.policy, tasks: planned.map(task => ({ request: task.request, estimate: { maxCostMicros: task.reservedMicros, catalogRevision: task.catalogRevision } })) }))
  return { ...runtime, connection, planned, intentHash }
}

/** The account, month and project budgets one admission reserves against. */
function budgetBuckets(account: string, projectId: string, policy: SeoPolicy, now: string) {
  return [
    { scope: `account-day:${account}`, period: now.slice(0, 10), limit: policy.accountDailyLimitMicros },
    { scope: `account-month:${account}`, period: now.slice(0, 7), limit: policy.accountMonthlyLimitMicros },
    { scope: `project-month:${projectId}`, period: now.slice(0, 7), limit: policy.projectMonthlyLimitMicros },
  ]
}

/** The reason a scheduled refresh that could not start stores on its failed run. */
function skippedRefreshReason(profileId: string | null, reason: string): string {
  return `Scheduled SEO refresh for ${profileId ? `profile "${profileId}"` : 'this project'} did not start: ${reason}`
}
// Profile ids are letters, digits, dots, hyphens and underscores, so a quote ends one.
const SKIPPED_REFRESH_PROFILE = /^Scheduled SEO refresh for profile "([^"]+)" did not start: /

/**
 * The profile a scheduled refresh that could not start was for, read back from the reason it
 * stored (`skippedRefreshReason`): such a run has no SEO job to name it. Null for any other run.
 */
export function skippedRefreshProfile(error: string | null): string | null {
  return error ? SKIPPED_REFRESH_PROFILE.exec(error)?.[1] ?? null : null
}

export interface ScheduledSeoRefreshOutcome {
  /** Null when the project has no saved profile. */
  profileId: string | null
  /** `started` admitted new work; `replayed` found this occurrence already admitted; `skipped` recorded a failed run. */
  status: 'started' | 'replayed' | 'skipped'
  runId: string
  reason?: string
  /** The unexpected error behind a generic reason, for the host's log only. */
  detail?: string
}

/**
 * Start one refresh per saved SEO profile for a schedule occurrence.
 *
 * The schedule is the standing approval, so there is no intent token; the
 * host's SEO policy still bounds every reservation exactly as for a manual
 * refresh. The idempotency key names the schedule, the occurrence and the
 * profile, so a repeated fire of the same occurrence returns the earlier
 * receipt instead of paying again. A refresh that cannot be admitted (no
 * profile, policy limit, stale scope, source not configured) leaves a failed
 * `seo-sync` run carrying the reason, so a skipped month is visible.
 */
export function startScheduledSeoRefreshes(
  db: DatabaseClient,
  opts: SeoRoutesOptions,
  input: { projectId: string; scheduleId: string; occurrence: string },
): ScheduledSeoRefreshOutcome[] {
  const repository = new SeoRepository(db)
  const principalId = `schedule:${input.scheduleId}`
  const recordSkipped = (profileId: string | null, reason: string, detail?: string): ScheduledSeoRefreshOutcome => {
    const runId = crypto.randomUUID(); const now = new Date().toISOString()
    db.insert(runs).values({ id: runId, projectId: input.projectId, kind: RunKinds['seo-sync'], status: RunStatuses.failed, trigger: RunTriggers.scheduled, createdAt: now, finishedAt: now, error: skippedRefreshReason(profileId, reason) }).run()
    return { profileId, status: 'skipped', runId, reason, ...(detail ? { detail } : {}) }
  }
  const saved = db.select().from(seoProfiles).where(eq(seoProfiles.projectId, input.projectId)).orderBy(asc(seoProfiles.id)).all().map(profileDto)
  if (!saved.length) return [recordSkipped(null, 'Save an SEO profile first.')]
  return saved.map(profile => {
    const idempotencyKey = `schedule:${input.scheduleId}:${input.occurrence}:${profile.id}`
    const prior = db.select().from(seoJobs).where(and(eq(seoJobs.projectKey, input.projectId), eq(seoJobs.idempotencyKey, idempotencyKey))).get()
    if (prior?.runId) return { profileId: profile.id, status: 'replayed', runId: prior.runId }
    try {
      const scopeSnapshot = resolveScope(db, input.projectId, profile)
      const runtime = planSeoTasks(opts, profile, marketRankingPlan(db, input.projectId, profile))
      const now = new Date().toISOString(); const account = runtime.connection.adapter.accountKey; const requestedId = crypto.randomUUID()
      const id = repository.admit({ id: requestedId, projectId: input.projectId, profileId: profile.id, profileRevision: profile.revision, profile, scopeSnapshot, requestHash: hash(idempotencyKey), idempotencyKey, principalId, accountKey: account, now, trigger: RunTriggers.scheduled, buckets: budgetBuckets(account, input.projectId, runtime.policy, now),
        tasks: runtime.planned.map(task => { const id = crypto.randomUUID(); return { ...task, id, request: { ...task.request, tag: id } } }) }, tx => writeAuditLog(tx, { projectId: input.projectId, actor: 'scheduler', action: 'seo.sync.requested', entityType: 'run', entityId: requestedId }))
      if (id === requestedId) opts.onSeoRunRequested?.(id)
      return { profileId: profile.id, status: id === requestedId ? 'started' : 'replayed', runId: id }
    } catch (error) {
      if (error instanceof AppError) return recordSkipped(profile.id, error.message)
      return recordSkipped(profile.id, 'The SEO refresh could not be admitted.', error instanceof Error ? error.message : String(error))
    }
  })
}

export async function seoRoutes(app: FastifyInstance, opts: SeoRoutesOptions) {
  const repository = new SeoRepository(app.db)
  // Intents are deliberately short-lived across restarts; durable accepted receipts remain replayable.
  const intentSecret = crypto.randomBytes(32)
  const getRuntime = () => opts.getSeoRuntime?.() ?? null
  const profiles = (projectId: string) => app.db.select().from(seoProfiles).where(eq(seoProfiles.projectId, projectId)).all().map(profileDto)
  const profile = (projectId: string, id: string) => {
    const row = app.db.select().from(seoProfiles).where(and(eq(seoProfiles.projectId, projectId), eq(seoProfiles.id, id))).get()
    if (!row) throw notFound('SEO profile', id)
    return profileDto(row)
  }
  // A retried search reads as its retry: customers see each search once, with the attempt that counts.
  const tasks = (id: string) => currentSeoTasks(app.db.select().from(seoTasks).where(eq(seoTasks.jobId, id)).orderBy(asc(seoTasks.id)).all())
  const taskCounts = (ids: string[]) => ids.length ? app.db.select({ jobId: seoTasks.jobId, status: seoTasks.status, count: sql<number>`count(*)` }).from(seoTasks).where(and(inArray(seoTasks.jobId, ids), currentSeoTaskCondition())).groupBy(seoTasks.jobId, seoTasks.status).all() : []
  const runSummary = (row: SeoJobRow) => runDto(row, taskCounts([row.id]))
  const job = (projectId: string, id: string) => {
    const row = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, projectId), isNotNull(seoJobs.runId), eq(seoJobs.id, id))).get()
    if (!row) throw notFound('SEO run', id)
    return row
  }
  const selected = (projectId: string, query: SeoEvidenceQuery, evidenceOnly = false) => {
    if (query.profileId) profile(projectId, query.profileId)
    if (!query.runId && !query.profileId && profiles(projectId).length > 1) throw validationError('Select an SEO profile explicitly.')
    if (query.runId) {
      const row = job(projectId, query.runId)
      if (query.profileId && row.profileId !== query.profileId) throw validationError('The SEO run does not belong to this profile.')
      return row
    }
    return app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, projectId), isNotNull(seoJobs.runId), query.profileId ? eq(seoJobs.profileId, query.profileId) : undefined, evidenceOnly ? inArray(seoJobs.status, [SeoRunStatuses.completed, SeoRunStatuses.partial]) : undefined)).orderBy(desc(seoJobs.createdAt), sql`seo_jobs.rowid DESC`).get() ?? null
  }
  const queryInput = (value: unknown): SeoEvidenceQuery => {
    const raw = (value ?? {}) as Record<string, unknown>
    const parsed = seoEvidenceQuerySchema.safeParse({ ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }), ...(raw.offset === undefined ? {} : { offset: Number(raw.offset) }) })
    if (!parsed.success) throw validationError('Invalid SEO evidence selection.')
    return parsed.data
  }
  const status = (projectId: string): SeoStatus => {
    const runtime = getRuntime()
    const latest = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, projectId), isNotNull(seoJobs.runId))).orderBy(desc(seoJobs.createdAt)).get()
    const last = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, projectId), isNotNull(seoJobs.runId), inArray(seoJobs.status, [SeoRunStatuses.completed, SeoRunStatuses.partial]))).orderBy(desc(seoJobs.finishedAt)).get()
    const available = !!runtime?.connections.length && !!opts.onSeoRunRequested
    return { available, reason: available ? null : 'SEO execution is not configured on this host.', capabilities: [...new Set(runtime?.connections.flatMap(connection => [...connection.adapter.capabilities]) ?? [])], profileCount: profiles(projectId).length, latestRunId: latest?.id ?? null, latestRunStatus: latest?.status ?? null, lastCompletedAt: last?.finishedAt ?? null }
  }
  const planTasks = (projectId: string, input: SeoProfileInput) => planSeoTasks(opts, input, marketRankingPlan(app.db, projectId, input))
  app.get<{ Params: { id: string } }>('/seo/operator/tasks/:id', async request => {
    requireOperator(request)
    const task = app.db.select().from(seoTasks).where(eq(seoTasks.id, request.params.id)).get()
    if (!task) throw notFound('SEO task', request.params.id)
    return { id: task.id, runId: task.jobId, status: task.status, reservedCostMicros: task.reservedMicros, actualCostMicros: task.actualMicros, receipts: task.receipts } satisfies SeoOperatorTask
  })
  app.post<{ Params: { id: string }; Body: unknown }>('/seo/operator/tasks/:id/reconcile', { config: { writeScope: SEO_RUN_SCOPE } }, async request => {
    requireOperator(request); requireScope(request, SEO_RUN_SCOPE)
    const parsed = seoReconcileInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Provide a verified upstream receipt and reconciliation note.')
    const task = app.db.select().from(seoTasks).where(eq(seoTasks.id, request.params.id)).get()
    if (!task) throw notFound('SEO task', request.params.id)
    app.db.transaction(tx => {
      repository.reconcile(task.id, parsed.data)
      writeAuditLog(tx, { actor: 'api', action: 'seo.task.reconciled', entityType: 'seo-task', entityId: task.id })
    })
    opts.onSeoRunRequested?.(task.jobId)
    return { id: task.id, status: app.db.select().from(seoTasks).where(eq(seoTasks.id, task.id)).get()!.status } satisfies SeoReconcileResult
  })
  type Params = { name: string; id: string }
  app.get<{ Params: Params }>('/projects/:name/seo/context', async request => {
    const project = resolveProject(app.db, request.params.name)
    const current = status(project.id)
    const active = activeMeasurementPlan(app.db, project.id)
    const plan = active?.plan.schemaVersion === 2 ? active.plan : null
    const scopes: SeoContext['scopes'] = plan ? planScopeOptions(plan, { marketLinks: true }).map(option => {
      const capabilities = scopeCapabilities(option.kind, scopedPlanTargets(plan, { kind: option.kind, ...(option.kind === SeoScopeKinds.project ? {} : { key: option.id }) }).targets).filter(capability => current.capabilities.includes(capability))
      return { kind: option.kind, key: option.kind === SeoScopeKinds.project ? null : option.id, label: option.label, planRevision: active!.version.revision, capabilities, supported: capabilities.length > 0, reason: !capabilities.length ? current.reason ?? 'No configured connection supports this scope.' : option.kind === SeoScopeKinds.project ? null : scopeReason(capabilities) }
    }) : [{ kind: SeoScopeKinds.project, key: null, label: 'Project', capabilities: active ? [] : current.capabilities, supported: !active && current.capabilities.length > 0, reason: active ? 'Publish a current Advanced Measurement plan first.' : current.reason }]
    return { available: current.available, reason: current.reason, connections: getRuntime()?.connections.map(connection => ({ id: connection.id, label: connection.label, provider: connection.adapter.provider, capabilities: [...connection.adapter.capabilities] })) ?? [], scopes, access: { canRun: can(request, SEO_RUN_SCOPE), canWrite: can(request, SEO_WRITE_SCOPE) } } satisfies SeoContext
  })
  app.get<{ Params: Params }>('/projects/:name/seo/status', async request => status(resolveProject(app.db, request.params.name).id))
  app.get<{ Params: Params }>('/projects/:name/seo/profiles', async request => ({ profiles: profiles(resolveProject(app.db, request.params.name).id) }))
  app.get<{ Params: Params }>('/projects/:name/seo/profiles/:id', async request => profile(resolveProject(app.db, request.params.name).id, request.params.id))
  app.put<{ Params: Params; Body: unknown }>('/projects/:name/seo/profiles/:id', { config: { writeScope: SEO_WRITE_SCOPE } }, async request => {
    requireScope(request, SEO_WRITE_SCOPE); requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)
    if (!/^[a-z0-9][\w.-]{0,99}$/i.test(request.params.id)) throw validationError('Use a stable SEO profile id of at most 100 letters, digits, dots, hyphens or underscores.')
    const parsed = seoProfileInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid SEO profile.', { issues: parsed.error.issues })
    const input = normalizeProfile(parsed.data)
    resolveScope(app.db, project.id, input)
    planTasks(project.id, input)
    const now = new Date().toISOString()
    app.db.transaction(tx => {
      const current = tx.select().from(seoProfiles).where(and(eq(seoProfiles.projectId, project.id), eq(seoProfiles.id, request.params.id))).get()
      if (current && JSON.stringify(current.input) === JSON.stringify(input)) return
      tx.insert(seoProfiles).values({ projectId: project.id, id: request.params.id, revision: 1, input, createdAt: now, updatedAt: now }).onConflictDoUpdate({ target: [seoProfiles.projectId, seoProfiles.id], set: { input, revision: sql`${seoProfiles.revision} + 1`, updatedAt: now } }).run()
      writeAuditLog(tx, { projectId: project.id, actor: 'api', action: 'seo.profile.updated', entityType: 'seo-profile', entityId: request.params.id })
    })
    return profile(project.id, request.params.id)
  })
  app.post<{ Params: Params; Body: unknown }>('/projects/:name/seo/refresh-intents', { config: { readSemantic: true } }, async request => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = seoRefreshIntentInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Select an SEO profile.')
    const saved = profile(project.id, parsed.data.profileId)
    const scope = resolveScope(app.db, project.id, saved)
    const planned = planTasks(project.id, saved)
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const payload = Buffer.from(JSON.stringify({ projectId: project.id, actor: actor(request), profileId: saved.id, revision: saved.revision, scopeHash: hash(JSON.stringify(scope)), intentHash: planned.intentHash, nonce: crypto.randomUUID(), expiresAt })).toString('base64url')
    const signature = crypto.createHmac('sha256', intentSecret).update(payload).digest('base64url')
    return { token: `${payload}.${signature}`, expiresAt, profileId: saved.id, profileRevision: saved.revision, taskCount: planned.planned.length, targets: saved.targets, capabilities: saved.capabilities, availability: SeoAvailability.ready, reason: null } satisfies SeoQuote
  })
  app.post<{ Params: Params; Body: unknown }>('/projects/:name/seo/sync', { config: { paidRead: true, writeScope: SEO_RUN_SCOPE } }, async (request, reply) => {
    requireScope(request, SEO_RUN_SCOPE); requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)
    const parsed = seoSyncInputSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid SEO refresh request.')
    const input = parsed.data
    const requestHash = hash(input.quoteToken)
    const byKey = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectKey, project.id), eq(seoJobs.idempotencyKey, input.idempotencyKey))).get()
    if (byKey && (byKey.requestHash !== requestHash || byKey.principalId !== actor(request))) throw validationError('This idempotency key belongs to a different SEO refresh.')
    const existing = byKey ?? app.db.select().from(seoJobs).where(and(eq(seoJobs.projectKey, project.id), eq(seoJobs.requestHash, requestHash))).orderBy(asc(seoJobs.createdAt), sql`seo_jobs.rowid ASC`).get()
    if (existing) {
      if (existing.principalId !== actor(request)) throw validationError('This refresh intent belongs to a different initiating credential.')
      if (!existing.runId) throw notFound('SEO run', existing.id)
      return runSummary(existing)
    }
    const [payload, signature, extra] = input.quoteToken.split('.')
    if (!payload || !signature || extra) throw validationError('Create a new SEO refresh intent.')
    const expected = crypto.createHmac('sha256', intentSecret).update(payload).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.toString('base64url') !== signature || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw validationError('Create a new SEO refresh intent.')
    let claims: { projectId: string; actor: string; profileId: string; revision: number; scopeHash: string; intentHash: string; expiresAt: string }
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as typeof claims } catch { throw validationError('Create a new SEO refresh intent.') }
    if (claims.projectId !== project.id || claims.actor !== actor(request) || Date.parse(claims.expiresAt) <= Date.now()) throw validationError('Create a new SEO refresh intent.')
    const saved = profile(project.id, claims.profileId)
    const scopeSnapshot = resolveScope(app.db, project.id, saved)
    if (saved.revision !== claims.revision || hash(JSON.stringify(scopeSnapshot)) !== claims.scopeHash) throw validationError('This SEO profile or measurement scope changed. Create a new refresh intent.')
    const runtime = planTasks(project.id, saved)
    if (runtime.intentHash !== claims.intentHash) throw validationError('The SEO connection or host policy changed. Create a new refresh intent.')
    const now = new Date().toISOString(); const account = runtime.connection.adapter.accountKey; const requestedId = crypto.randomUUID()
    const id = repository.admit({ id: requestedId, projectId: project.id, profileId: saved.id, profileRevision: saved.revision, profile: saved, scopeSnapshot, requestHash, idempotencyKey: input.idempotencyKey, principalId: actor(request), accountKey: account, now, buckets: budgetBuckets(account, project.id, runtime.policy, now), tasks: runtime.planned.map(task => { const id = crypto.randomUUID(); return { ...task, id, request: { ...task.request, tag: id } } }) }, tx => writeAuditLog(tx, { projectId: project.id, actor: 'api', action: 'seo.sync.requested', entityType: 'run', entityId: requestedId }))
    const accepted = job(project.id, id)
    if (id === requestedId) opts.onSeoRunRequested?.(id)
    return reply.status(id === requestedId ? 202 : 200).send(runSummary(accepted))
  })
  app.get<{ Params: Params; Querystring: { profileId?: string } }>('/projects/:name/seo/runs', async request => {
    const project = resolveProject(app.db, request.params.name)
    if (request.query.profileId) profile(project.id, request.query.profileId)
    const rows = app.db.select().from(seoJobs).where(and(eq(seoJobs.projectId, project.id), isNotNull(seoJobs.runId), request.query.profileId ? eq(seoJobs.profileId, request.query.profileId) : undefined)).orderBy(desc(seoJobs.createdAt), sql`seo_jobs.rowid DESC`).limit(100).all()
    const counts = taskCounts(rows.map(row => row.id))
    return { runs: rows.map(row => runDto(row, counts.filter(group => group.jobId === row.id))) }
  })
  app.get<{ Params: Params }>('/projects/:name/seo/runs/:id', async request => {
    const row = job(resolveProject(app.db, request.params.name).id, request.params.id)
    const rows = tasks(row.id); const results = resultRows(rows)
    return { ...runDto(row, rows.map(task => ({ status: task.status, count: 1 }))), tasks: rows.map(task => ({ id: task.id, capability: task.request.capability, target: task.request.target, comparison: task.request.comparison ?? null, status: task.status, error: task.error, remoteTaskId: task.receipts[0]?.remoteTaskId ?? null, ...taskSearch(task), retried: task.retryOf !== null })), results: { keywordMetrics: results.keywordMetrics.slice(0, 20), domainIntelligence: results.domainIntelligence.slice(0, 20), rankedKeywords: results.rankedKeywords.slice(0, 20), marketRankings: [...results.marketRankings].sort(compareMarketRankings).slice(0, 20), competitors: results.competitors.slice(0, 20), keywordGaps: results.keywordGaps.slice(0, 20) }, resultCounts: { keywordMetrics: results.keywordMetrics.length, domainIntelligence: results.domainIntelligence.length, rankedKeywords: results.rankedKeywords.length, marketRankings: results.marketRankings.length, competitors: results.competitors.length, keywordGaps: results.keywordGaps.length }, resultsTruncated: Object.values(results).some(items => items.length > 20) } satisfies SeoRunDetail
  })
  app.post<{ Params: Params }>('/projects/:name/seo/runs/:id/cancel', { config: { paidRead: true, writeScope: SEO_RUN_SCOPE } }, async request => {
    requireScope(request, SEO_RUN_SCOPE); requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name); const row = job(project.id, request.params.id)
    cancelSeoRefresh(app.db, project.id, row.id)
    return runSummary(job(project.id, row.id))
  })
  app.get<{ Params: Params; Querystring: SeoEvidenceQuery }>('/projects/:name/seo/overview', async request => {
    const project = resolveProject(app.db, request.params.name); const query = queryInput(request.query); const latest = selected(project.id, query); const row = selected(project.id, query, true); const rows = row ? tasks(row.id) : []; const results = resultRows(rows)
    const primary = row?.profile.targets[0]
    const domain = primary ? results.domainIntelligence.find(result => result.target.kind === primary.kind && result.target.value === primary.value && result.target.includeSubdomains === primary.includeSubdomains) : null
    return { status: status(project.id), profiles: profiles(project.id), latestRun: latest ? runSummary(latest) : null, evidenceRunId: row?.id ?? null, evidenceRun: row ? runDto(row, rows.map(task => ({ status: task.status, count: 1 }))) : null, keywordMetricsCount: results.keywordMetrics.length, domainIntelligenceCount: results.domainIntelligence.length, rankedKeywordCount: results.rankedKeywords.length, marketRankingCount: results.marketRankings.length, competitorCount: results.competitors.length, keywordGapCount: results.keywordGaps.length, summary: domain ? { target: domain.target, organicKeywords: domain.organicKeywords, inTop10: domain.top1 !== null && domain.top2To3 !== null && domain.top4To10 !== null ? domain.top1 + domain.top2To3 + domain.top4To10 : null, estimatedOrganicTraffic: domain.estimatedOrganicTraffic, provenance: domain.provenance } : null } satisfies SeoOverview
  })
  for (const [path, key] of [['keyword-metrics', 'keywordMetrics'], ['domain-intelligence', 'domainIntelligence'], ['ranked-keywords', 'rankedKeywords']] as const) app.get<{ Params: Params; Querystring: SeoEvidenceQuery }>(`/projects/:name/seo/${path}`, async request => {
    const query = queryInput(request.query); const row = selected(resolveProject(app.db, request.params.name).id, query, true)
    const items = row ? resultRows(tasks(row.id))[key] : []; const limit = query.limit ?? 50; const offset = query.offset ?? 0
    return { runId: row?.id ?? null, items: items.slice(offset, offset + limit), total: items.length, limit, offset }
  })
  app.get<{ Params: Params; Querystring: SeoCompetitorQuery }>('/projects/:name/seo/competitors', async request => {
    const raw = request.query as Record<string, unknown>
    const parsed = seoCompetitorQuerySchema.safeParse({ ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }), ...(raw.offset === undefined ? {} : { offset: Number(raw.offset) }) })
    if (!parsed.success) throw validationError('Invalid SEO competitor selection.')
    const query = parsed.data; const row = selected(resolveProject(app.db, request.params.name).id, query, true)
    const items = row ? resultRows(tasks(row.id)).competitors : []
    if (query.sort) items.sort(compareSeoCompetitorsBy(query.sort))
    const limit = query.limit ?? 50; const offset = query.offset ?? 0
    return { runId: row?.id ?? null, items: items.slice(offset, offset + limit), total: items.length, limit, offset } satisfies SeoCompetitorList
  })
  app.get<{ Params: Params; Querystring: SeoKeywordGapQuery }>('/projects/:name/seo/keyword-gaps', async request => {
    const raw = request.query as Record<string, unknown>
    const parsed = seoKeywordGapQuerySchema.safeParse({ ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }), ...(raw.offset === undefined ? {} : { offset: Number(raw.offset) }) })
    if (!parsed.success) throw validationError('Invalid SEO keyword-gap selection.')
    const query = parsed.data; const row = selected(resolveProject(app.db, request.params.name).id, query, true)
    const items = (row ? resultRows(tasks(row.id)).keywordGaps : []).filter(item => !query.kind || (query.kind === SeoKeywordGapKinds.shared ? item.kind !== SeoKeywordGapKinds.missing : item.kind === query.kind))
    if (query.sort) items.sort(compareSeoKeywordGapsBy(query.sort))
    const limit = query.limit ?? 50; const offset = query.offset ?? 0
    return { runId: row?.id ?? null, items: items.slice(offset, offset + limit), total: items.length, limit, offset } satisfies SeoKeywordGapList
  })
  app.get<{ Params: Params; Querystring: SeoMarketRankingQuery }>('/projects/:name/seo/market-rankings', async request => {
    const raw = (request.query ?? {}) as Record<string, unknown>
    const parsed = seoMarketRankingQuerySchema.safeParse({ ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }), ...(raw.offset === undefined ? {} : { offset: Number(raw.offset) }) })
    if (!parsed.success) throw validationError('Invalid SEO evidence selection.')
    const query = parsed.data; const row = selected(resolveProject(app.db, request.params.name).id, query, true)
    const items = (row ? resultRows(tasks(row.id)).marketRankings.map(marketRankingRow) : [])
      .filter(item => (query.marketKey === undefined || item.marketKey === query.marketKey) && (query.regionKey === undefined || item.regionKey === query.regionKey)
        && (query.outcome === undefined || matchesMarketRankingFilter(item, query.outcome)) && (query.q === undefined || matchesMarketRankingText(item, query.q)))
      .sort(compareMarketRankingsBy(query.sort ?? SeoMarketRankingSorts.market))
    const limit = query.limit ?? 50; const offset = query.offset ?? 0
    return { runId: row?.id ?? null, items: items.slice(offset, offset + limit), total: items.length, limit, offset } satisfies SeoMarketRankingList
  })
  app.get<{ Params: Params; Querystring: SeoMarketRankingSummaryQuery }>('/projects/:name/seo/market-rankings/summary', async request => {
    const parsed = seoMarketRankingSummaryQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) throw validationError('Invalid SEO evidence selection.')
    const query = parsed.data; const row = selected(resolveProject(app.db, request.params.name).id, query, true)
    const rows = (row ? resultRows(tasks(row.id)).marketRankings.map(marketRankingRow) : [])
      .filter(item => (query.marketKey === undefined || item.marketKey === query.marketKey) && (query.regionKey === undefined || item.regionKey === query.regionKey))
    return {
      // The depth each search asked for; a partial search's rows say how far they reached.
      runId: row?.id ?? null, depth: row?.profile.rankings?.depth ?? null,
      regionKey: query.regionKey ?? null, marketKey: query.marketKey ?? null,
      regionLabel: query.regionKey === undefined ? null : rows[0]?.regionLabel ?? null,
      marketLabel: query.marketKey === undefined ? null : rows[0]?.marketLabel ?? null,
      totals: countMarketRankings(rows), groups: groupMarketRankings(rows, { regionKey: query.regionKey, marketKey: query.marketKey }),
    } satisfies SeoMarketRankingSummary
  })
}
