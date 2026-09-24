import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MEASUREMENT_PORTFOLIO_TIE_NOTE,
  measurementChangesResponseSchema,
  measurementOverviewResponseSchema,
  measurementPortfolioSummaryResponseSchema,
  measurementPropertyCompetitorsResponseSchema,
  measurementPropertyEvidenceResponseSchema,
  measurementPropertyQuestionsResponseSchema,
  runDtoSchema,
  sourceBreakdownDtoSchema,
  visibilityReportResponseSchema,
} from '@ainyc/canonry-contracts'
import {
  GROUND_TRUTH_BUILDERS,
  MAX_FACTS_CHARS,
  applyPlaceholders,
  buildGroundTruth,
  builderPlaceholders,
  fitFacts,
  parseBuilderRef,
  type GroundTruthContext,
} from '../eval/aero/ground-truth.js'
import type { EvalQuestionSet, ProjectKind } from '../eval/aero/types.js'

// Fixtures are fictional and checked against the real response contracts, so
// a builder is tested on the shapes the server actually returns.

const KEY = 'cnry_ground_truth_test_key_0001'
const PROJECT = 'demo-portfolio'
const P = `/projects/${PROJECT}`
const COMPLETED = '2026-09-15T10:00:00.000Z'
const PREVIOUS_COMPLETED = '2026-09-01T10:00:00.000Z'

/** Facts are plain JSON: read them back untyped, as the grader does. */
function json(value: unknown) {
  return JSON.parse(JSON.stringify(value))
}

function valid<T>(schema: { parse: (value: unknown) => unknown }, value: T): T {
  schema.parse(value)
  return value
}

function metric(numerator: number, denominator: number) {
  return { state: 'available' as const, value: numerator / denominator, numerator, denominator }
}

/** A count metric such as Properties mentioned: the value is the count itself. */
function count(numerator: number, denominator: number) {
  return { state: 'available' as const, value: numerator, numerator, denominator }
}

function delta(previous: ReturnType<typeof metric>, current: ReturnType<typeof metric>) {
  return { state: 'available' as const, previous, current, delta: current.value - previous.value }
}

interface Recorded {
  method: string
  url: URL
  headers: Record<string, string>
}

type Handler = (url: URL) => unknown

function stubServer(kind: ProjectKind, routes: Record<string, Handler>) {
  const requests: Recorded[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ method: init?.method ?? 'GET', url, headers: { ...(init?.headers as Record<string, string>) } })
    const route = url.pathname.replace(/^\/api\/v1/, '')
    const handler = routes[route]
    const body = handler ? handler(url) : undefined
    if (body instanceof Response) return body
    if (body === undefined) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no stub for ${route}${url.search}` } }), { status: 404 })
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const ctx: GroundTruthContext = {
    baseUrl: 'http://127.0.0.1:4999/',
    headers: { authorization: `Bearer ${KEY}` },
    project: PROJECT,
    kind,
    fetch: fetchImpl,
  }
  return { ctx, requests }
}

// ── Shared fixtures: a four-Property portfolio in two metros ───────────────

const NORTH = { groupKey: 'north-metro', label: 'North Metro' }
const SOUTH = { groupKey: 'south-metro', label: 'South Metro' }

interface PropertyFixture {
  targetKey: string
  label: string
  metro: typeof NORTH
  queries: number
  mention: ReturnType<typeof metric>
  citation: ReturnType<typeof metric>
}

const ALDER: PropertyFixture = { targetKey: 'alder-court', label: 'Alder Court', metro: NORTH, queries: 4, mention: metric(0, 12), citation: metric(0, 12) }
const BIRCH: PropertyFixture = { targetKey: 'birch-hall', label: 'Birch Hall', metro: SOUTH, queries: 8, mention: metric(0, 24), citation: metric(0, 24) }
// Tied at the weakest rates but absent from every summary list: its metro must come from the per-metro read.
const CEDAR: PropertyFixture = { targetKey: 'cedar-row', label: 'Cedar Row', metro: NORTH, queries: 4, mention: metric(0, 12), citation: metric(0, 12) }
const DOGWOOD: PropertyFixture = { targetKey: 'dogwood-lane', label: 'Dogwood Lane', metro: NORTH, queries: 4, mention: metric(6, 12), citation: metric(2, 12) }
const ALL = [ALDER, BIRCH, CEDAR, DOGWOOD]

function weakRow(property: PropertyFixture, named: Array<[string, number]>, domains: Array<[string, number]>) {
  return {
    targetKey: property.targetKey,
    label: property.label,
    metro: property.metro,
    submarkets: [`Harbor District, ${property.metro.label}`],
    queries: property.queries,
    mentionCoverage: property.mention,
    citationCoverage: property.citation,
    flags: 0,
    namedInsteadInAnswerText: named.map(([name, answers]) => ({ name, answers })),
    namedInsteadInAnswerTextTotal: named.length,
    citedDomains: domains.map(([domain, answers]) => ({ domain, answers })),
    citedDomainsTotal: domains.length,
    recommendedInstead: named.map(([name, occurrences]) => ({ name, occurrences })),
    recommendedInsteadTotal: named.length,
    recommendedInsteadTruncated: false,
  }
}

function rankedRow(property: PropertyFixture) {
  return {
    targetKey: property.targetKey,
    label: property.label,
    metro: property.metro,
    submarkets: [],
    queries: property.queries,
    mentionCoverage: property.mention,
    citationCoverage: property.citation,
  }
}

const portfolioSummary = valid(measurementPortfolioSummaryResponseSchema, {
  portfolio: { groupKey: null, label: null, measurementScope: 'full' },
  measurement: { state: 'complete', displayedRunId: 'run-cur', planRevision: 3, completedAt: COMPLETED },
  queryClass: 'non-brand',
  engines: ['gemini', 'openai'],
  metrics: { propertiesMentioned: count(1, 4), mentionCoverage: metric(6, 60), citationCoverage: metric(2, 60) },
  weakestProperties: [
    weakRow(ALDER, [['Elm Place', 4], ['Fir Commons', 2]], [['listings.example', 7], ['rentals.example', 3]]),
    weakRow(BIRCH, [['Grove Tower', 6]], [['listings.example', 12]]),
  ],
  tiedAtWeakest: { count: 3, mentionRate: 0, citationRate: 0, note: MEASUREMENT_PORTFOLIO_TIE_NOTE },
  weakestAnswerSources: {
    properties: 3,
    answers: 48,
    domains: [{ domain: 'listings.example', answers: 30 }, { domain: 'rentals.example', answers: 11 }],
    domainTotal: 9,
  },
  mentionRanking: {
    eligiblePropertyCount: 4,
    strongest: [rankedRow(DOGWOOD)],
    weakest: [rankedRow(ALDER), rankedRow(BIRCH)],
    excluded: [],
    truncated: true,
  },
  markets: [
    { groupKey: 'south-metro', label: 'South Metro', parentGroupKey: null, childMarketCount: 0, propertyCount: 1, propertiesMentioned: count(0, 1), mentionCoverage: metric(0, 24), citationCoverage: metric(0, 24) },
    { groupKey: 'north-metro', label: 'North Metro', parentGroupKey: null, childMarketCount: 1, propertyCount: 3, propertiesMentioned: count(1, 3), mentionCoverage: metric(6, 36), citationCoverage: metric(2, 36) },
    { groupKey: 'harbor-district', label: 'Harbor District', parentGroupKey: 'north-metro', childMarketCount: 0, propertyCount: 1, propertiesMentioned: count(0, 1), mentionCoverage: metric(0, 12), citationCoverage: metric(0, 12) },
  ],
  totalMarkets: 3,
  marketsTruncated: false,
  totalProperties: 4,
  truncated: true,
})

function overviewRow(property: PropertyFixture, mention = property.mention, citation = property.citation) {
  return {
    targetKey: property.targetKey,
    label: property.label,
    mentionCoverage: mention,
    citationCoverage: citation,
    providers: [{ provider: 'gemini', mentionCoverage: mention, citationCoverage: citation }],
    flags: 0,
  }
}

function overviewPage(rows: ReturnType<typeof overviewRow>[], opts: { nextCursor?: string; runId?: string; queryClass?: string; scope?: 'all' | 'group' | 'property' } = {}) {
  const neither = rows.filter(row => row.mentionCoverage.numerator === 0 && row.citationCoverage.numerator === 0).length
  return valid(measurementOverviewResponseSchema, {
    mode: 'active-v2',
    scope: { kind: opts.scope ?? 'all', label: 'All Properties' },
    queryClass: opts.queryClass ?? 'non-brand',
    measurement: { state: 'complete', currentRunId: 'run-cur', displayedRunId: opts.runId ?? 'run-cur', completed: 60, expected: 60, completedAt: COMPLETED },
    nextAction: { kind: 'none' },
    metrics: { propertiesMentioned: count(1, 4), mentionCoverage: metric(6, 60), citationCoverage: metric(2, 60), brandPresence: metric(6, 60), sov: metric(6, 60) },
    properties: { items: rows, nextCursor: opts.nextCursor ?? null, totalEstimate: rows.length },
    outcomes: { bothSignals: rows.length - neither, mentionedOnly: 0, citedOnly: 0, neither, notMeasured: 0, total: rows.length },
    flags: { total: 0 },
  })
}

function runDto(id: string, status: string, trigger: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return valid(runDtoSchema, {
    id,
    projectId: 'project-1',
    kind: 'answer-visibility',
    status,
    trigger,
    measurementScope: null,
    location: null,
    startedAt: createdAt,
    finishedAt: status === 'running' ? null : createdAt.replace('T09', 'T10'),
    createdAt,
    ...extra,
  })
}

// Oldest first, as the route returns them.
const RUNS = [
  runDto('run-prev', 'completed', 'scheduled', '2026-09-01T09:00:00.000Z'),
  runDto('run-probe', 'completed', 'probe', '2026-09-10T09:00:00.000Z'),
  runDto('run-cur', 'completed', 'scheduled', '2026-09-15T09:00:00.000Z'),
  runDto('run-new', 'failed', 'manual', '2026-09-16T09:00:00.000Z', { error: { providers: { gemini: { message: 'quota exhausted' } } } }),
]

function overviewHandler(url: URL) {
  const params = url.searchParams
  const scope = params.get('scope')
  if (scope === 'group') {
    if (params.get('groupKey') === 'north-metro') return overviewPage([ALDER, CEDAR, DOGWOOD].map(p => overviewRow(p)), { scope: 'group' })
    if (params.get('groupKey') === 'south-metro') return overviewPage([overviewRow(BIRCH)], { scope: 'group' })
    return undefined
  }
  if (scope === 'property') {
    const property = ALL.find(item => item.targetKey === params.get('targetKey'))
    if (!property) return undefined
    const branded = params.get('queryClass') === 'branded'
    const row = branded ? overviewRow(property, metric(4, 4), metric(2, 4)) : overviewRow(property)
    return overviewPage([row], { scope: 'property', queryClass: branded ? 'branded' : 'non-brand' })
  }
  if (params.get('runId') === 'run-prev') {
    return overviewPage([
      overviewRow(ALDER, metric(1, 12), metric(0, 12)),
      overviewRow(BIRCH),
      overviewRow(CEDAR),
      overviewRow(DOGWOOD, metric(2, 12), metric(2, 12)),
    ], { runId: 'run-prev' })
  }
  // Two pages, so the builders must follow the cursor.
  if (params.get('cursor') === 'page-2') return overviewPage([overviewRow(CEDAR), overviewRow(DOGWOOD)])
  return overviewPage([overviewRow(ALDER), overviewRow(BIRCH)], { nextCursor: 'page-2' })
}

function rankedList(entries: Array<[string, number, string]>, answerTotal: number) {
  const totalCitedSlots = entries.reduce((sum, [, count]) => sum + count, 0)
  return {
    totalCitedSlots,
    answerTotal,
    answersWithSources: answerTotal,
    domainTotal: entries.length,
    entries: entries.map(([domain, count, surfaceClass]) => ({
      domain,
      count,
      percentage: count / totalCitedSlots,
      answerShare: count / answerTotal,
      category: 'other',
      label: 'Other',
      surfaceClass,
    })),
    truncatedDomainCount: 0,
    truncatedCitedSlots: 0,
    bySurfaceClass: [{ surfaceClass: 'other', label: 'Other sources', count: totalCitedSlots, percentage: 1, domainCount: entries.length }],
  }
}

function sourcesHandler(url: URL) {
  const runId = url.searchParams.get('runId')
  const queryClass = url.searchParams.get('queryClass') ?? 'all'
  const nonBrand = queryClass === 'non-brand'
  const ranked = nonBrand
    ? rankedList([['listings.example', 40, 'other'], ['rentals.example', 20, 'other'], ['example-brand.com', 5, 'own']], 60)
    : rankedList([['example-brand.com', 50, 'own'], ['listings.example', 45, 'other']], 90)
  return valid(sourceBreakdownDtoSchema, {
    ranked,
    byProvider: { gemini: rankedList([['listings.example', 25, 'other']], 30), openai: rankedList([['rentals.example', 12, 'other']], 30) },
    providersWithoutSources: [],
    answerTotal: ranked.answerTotal,
    runCount: runId ? 1 : 2,
    unclassifiedAnswers: 0,
    filters: { runId, queryClass, queryClassBasis: nonBrand ? 'measurement-plan' : null, includeByQuery: false },
    runId: runId ?? 'run-cur',
    window: 'all',
    limit: 50,
    overall: [],
  })
}

const advancedRoutes: Record<string, Handler> = {
  [`${P}/measurement-portfolio-summary`]: () => portfolioSummary,
  [`${P}/measurement-overview`]: overviewHandler,
  [`${P}/runs`]: () => RUNS,
  [`${P}/analytics/sources`]: sourcesHandler,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildGroundTruth: advanced builders', () => {
  it('portfolio-weakest states the tie, groups tied Properties by their real metro, and reads only with GETs', async () => {
    const { ctx, requests } = stubServer('advanced', advancedRoutes)
    const truth = await buildGroundTruth('portfolio-weakest', ctx)
    const facts = json(truth.facts)

    expect(truth.builder).toBe('portfolio-weakest')
    expect(facts.queryClass).toBe('non-brand')
    expect(facts.portfolio).toEqual({ properties: 4, propertiesMentioned: '1/4', mentionCoverage: '6/60 (10.0%)', citationCoverage: '2/60 (3.3%)' })
    expect(facts.tiedAtWeakest).toMatchObject({ count: 3, mentionRate: '0.0%', citationRate: '0.0%' })
    // Cedar Row is in no summary list: its metro comes from the per-metro overview read.
    expect(facts.tiedPropertiesByMetro).toEqual([
      { metro: 'North Metro', count: 2, properties: ['Alder Court', 'Cedar Row'] },
      { metro: 'South Metro', count: 1, properties: ['Birch Hall'] },
    ])
    expect(facts.propertiesAtZeroMention).toBe(3)
    expect(facts.propertiesAtZeroMentionAndCitation).toBe(3)
    expect(facts.weakest.rows[0]).toMatchObject({
      property: 'Alder Court',
      metro: 'North Metro',
      mention: '0/12 (0.0%)',
      citation: '0/12 (0.0%)',
      namedInsteadInAnswerText: ['Elm Place (4)', 'Fir Commons (2)'],
      citedDomains: ['listings.example (7)', 'rentals.example (3)'],
    })
    expect(facts.largestNamedInsteadCounts[0]).toBe('Grove Tower: 6 answers for Birch Hall')
    expect(facts.weakestAnswerSources.top).toEqual(['listings.example: 30 answers', 'rentals.example: 11 answers'])
    // Probe runs never count; the newest failed run is not the latest complete sweep.
    expect(facts.run.measuredRunId).toBe('run-cur')
    expect(facts.run.latestCompleteSweep).toContain('run-cur')
    expect(facts.run.previousCompleteSweep).toContain('run-prev')
    expect(JSON.stringify(facts).length).toBeLessThanOrEqual(MAX_FACTS_CHARS)

    expect(requests.every(request => request.method === 'GET')).toBe(true)
    expect(requests.every(request => request.headers.authorization === `Bearer ${KEY}`)).toBe(true)
    const summaryRead = requests.find(request => request.url.pathname.endsWith('/measurement-portfolio-summary'))
    expect(summaryRead?.url.pathname).toBe(`/api/v1${P}/measurement-portfolio-summary`)
    expect(Object.fromEntries(summaryRead!.url.searchParams)).toEqual({ queryClass: 'non-brand', limit: '50', includeNestedMarkets: 'true' })
    // The overview was paged through its cursor.
    expect(requests.some(request => request.url.searchParams.get('cursor') === 'page-2')).toBe(true)
  })

  it('shares reads across builders on one context', async () => {
    const { ctx, requests } = stubServer('advanced', advancedRoutes)
    await buildGroundTruth('portfolio-weakest', ctx)
    const before = requests.length
    await buildGroundTruth('market-gaps', ctx)
    expect(requests.length).toBe(before)
  })

  it('market-gaps lists metros worst-first and counts zero Properties per metro', async () => {
    const { ctx } = stubServer('advanced', advancedRoutes)
    const facts = json((await buildGroundTruth('market-gaps', ctx)).facts)
    expect(facts.metros.total).toBe(2)
    expect(facts.metros.rows.map((row: { market: string }) => row.market)).toEqual(['South Metro', 'North Metro'])
    expect(facts.metros.rows[1]).toMatchObject({ properties: 3, propertiesMentioned: '1/3', mention: '6/36 (16.7%)' })
    expect(facts.nestedMarkets.worst[0]).toMatchObject({ market: 'Harbor District', parent: 'North Metro' })
    expect(facts.propertiesAtZeroByMetro).toEqual([
      { metro: 'North Metro', properties: 3, zeroMention: 2, zeroMentionAndCitation: 2 },
      { metro: 'South Metro', properties: 1, zeroMention: 1, zeroMentionAndCitation: 1 },
    ])
  })

  it('sources-nonbrand reads the measured run for non-brand only and keeps pooled figures as a labelled contrast', async () => {
    // This one goes through the global fetch, the default when a context passes none.
    const { ctx, requests } = stubServer('advanced', advancedRoutes)
    vi.stubGlobal('fetch', ctx.fetch)
    const truth = await buildGroundTruth('sources-nonbrand', { ...ctx, fetch: undefined })
    const facts = json(truth.facts)

    const nonBrandRead = requests.find(request => request.url.pathname.endsWith('/analytics/sources') && request.url.searchParams.get('queryClass') === 'non-brand')
    expect(nonBrandRead?.url.searchParams.get('runId')).toBe('run-cur')
    expect(nonBrandRead?.url.searchParams.get('includeByQuery')).toBe('false')
    expect(facts.classBasis).toBe('measurement-plan')
    expect(facts.sweepsPooled).toBe(1)
    expect(facts.nonBrand.top[0]).toBe('listings.example: 40 answers (66.7% of answers) [other]')
    expect(facts.ownSiteNonBrand).toEqual(['#3 example-brand.com: 5 answers'])
    expect(facts.byEngine.gemini.top).toEqual(['listings.example: 25 answers (83.3% of answers) [other]'])
    expect(facts.pooledContrast.sameSweepBothClasses.ownSite).toEqual(['#1 example-brand.com: 50 answers'])
    expect(facts.pooledContrast.everySweepBothClasses.sweepsPooled).toBe(2)
  })

  it('sweep-changes compares the two runs per Property, keeps classes apart, and records a failed secondary read', async () => {
    const changes = (queryClass: 'branded' | 'non-brand') => valid(measurementChangesResponseSchema, {
      current: { state: 'complete', displayedRunId: 'run-cur', planRevision: 3, completedAt: COMPLETED, executionIdentity: 'exec-1', measurementScope: 'full' },
      comparison: {
        state: 'available',
        previous: { displayedRunId: 'run-prev', planRevision: 3, completedAt: PREVIOUS_COMPLETED, executionIdentity: 'exec-1', measurementScope: 'full' },
        metrics: queryClass === 'non-brand'
          ? {
              propertiesMentioned: delta(count(2, 4), count(1, 4)),
              mentionCoverage: delta(metric(3, 60), metric(6, 60)),
              citationCoverage: delta(metric(2, 60), metric(2, 60)),
            }
          : {
              propertiesMentioned: delta(count(4, 4), count(4, 4)),
              mentionCoverage: delta(metric(20, 24), metric(22, 24)),
              citationCoverage: delta(metric(10, 24), metric(10, 24)),
            },
        changedProperties: [],
        totalProperties: 2,
        truncated: false,
      },
    })
    const { ctx } = stubServer('advanced', {
      ...advancedRoutes,
      [`${P}/measurement-changes`]: url => changes(url.searchParams.get('queryClass') as 'branded' | 'non-brand'),
      [`${P}/visibility-report`]: () => new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }), { status: 500 }),
    })
    const facts = json((await buildGroundTruth('sweep-changes', ctx)).facts)

    expect(facts.current.runId).toBe('run-cur')
    expect(facts.previous.runId).toBe('run-prev')
    expect(facts.nonBrand.mentionCoverage).toBe('3/60 (5.0%) -> 6/60 (10.0%) (+5.0 pts)')
    expect(facts.nonBrand.propertiesMentioned).toBe('2/4 -> 1/4 (-1)')
    expect(facts.branded.mentionCoverage).toBe('20/24 (83.3%) -> 22/24 (91.7%) (+8.3 pts)')
    const moves = facts.nonBrandPropertyMoves
    expect(moves.mentionAnswerChangePerProperty).toEqual({ unchanged: 2, oneAnswer: 1, twoAnswers: 0, threeOrMore: 1, notComparable: 0 })
    expect(moves.medianPropertyDenominator).toBe(12)
    expect(moves.mentionGainers.top).toEqual(['Dogwood Lane: mention 2/12 (16.7%) -> 6/12 (50.0%) (+33.3 pts); citation 2/12 (16.7%) -> 2/12 (16.7%) (0.0 pts)'])
    expect(moves.mentionLosers.top[0]).toMatch(/^Alder Court: mention 1\/12 \(8\.3%\) -> 0\/12 \(0\.0%\) \(-8\.3 pts\)/)
    expect(facts.projectReportByClass).toMatch(/^read failed: GET .*visibility-report.* HTTP 500 INTERNAL: boom/)
  })

  it('property-drilldown picks the weakest Property whose answers name someone else most, and fills {property}', async () => {
    const questionRow = (queryId: string, text: string, provider: string, mentioned: boolean | null, cited: boolean | null) => ({
      resultId: `${queryId}-${provider}`,
      queryId,
      text,
      class: 'non-brand',
      provider,
      requestedModel: null,
      servedModel: null,
      location: null,
      status: 'answered',
      mentioned,
      cited,
      recommendedInstead: [],
      answerExcerpt: null,
    })
    const answer = (id: string, provider: string, urls: string[]) => ({
      observationId: `obs-${id}`,
      expectedSlotId: `slot-${id}`,
      executionId: `exec-${id}`,
      usageEdgeId: `edge-${id}`,
      usageEdgeType: 'target',
      provider,
      queryText: 'best places in south metro',
      location: null,
      queryClass: 'non-brand',
      mentioned: false,
      cited: false,
      sources: urls.map(url => ({ sourceUrl: url, normalizedUrl: url, classification: 'external', matchedTargetIds: [], matchedUrlIds: [] })),
      sourceCount: urls.length,
      sourcesTruncated: false,
      bridged: false,
      historical: false,
      evidenceComplete: true,
    })
    const property = { targetKey: 'birch-hall', label: 'Birch Hall' }
    const measurement = { state: 'complete', displayedRunId: 'run-cur', planRevision: 3, completedAt: COMPLETED }
    const { ctx, requests } = stubServer('advanced', {
      ...advancedRoutes,
      [`${P}/measurement-property-questions`]: () => valid(measurementPropertyQuestionsResponseSchema, {
        property,
        measurement,
        queryClass: 'non-brand',
        questions: [
          questionRow('q1', 'best places in south metro', 'gemini', false, false),
          questionRow('q1', 'best places in south metro', 'openai', false, false),
          questionRow('q2', 'quiet places near the river', 'gemini', false, null),
          {
            resultId: null, queryId: 'q2', text: 'quiet places near the river', class: 'non-brand', provider: 'openai',
            requestedModel: null, servedModel: null, location: null, status: 'missing', mentioned: null, cited: null, recommendedInstead: [], answerExcerpt: null,
          },
        ],
        total: 4,
        truncated: false,
      }),
      [`${P}/measurement-property-competitors`]: () => valid(measurementPropertyCompetitorsResponseSchema, {
        property,
        measurement,
        queryClass: 'non-brand',
        basis: { state: 'available', answeredResults: 3, targetMissResults: 3, recommendationOccurrences: 7 },
        competitors: [{
          name: 'Grove Tower', occurrences: 6, providers: ['gemini', 'openai'], providerTotal: 2, providersTruncated: false,
          questions: ['best places in south metro'], questionTotal: 1, questionsTruncated: false,
        }],
        total: 1,
        truncated: false,
      }),
      [`${P}/measurement-property-evidence`]: () => valid(measurementPropertyEvidenceResponseSchema, {
        property,
        queryClass: 'non-brand',
        measurement: { state: 'complete', displayedRunId: 'run-cur', completedAt: COMPLETED },
        answers: {
          items: [
            answer('a1', 'gemini', ['https://www.listings.example/south/1', 'https://grovetower.example/']),
            answer('a2', 'openai', ['https://listings.example/south/2']),
            answer('a3', 'gemini', []),
          ],
          nextCursor: null,
        },
      }),
    })
    const truth = await buildGroundTruth('property-drilldown', ctx)
    const facts = json(truth.facts)

    expect(truth.placeholders).toEqual({ property: 'Birch Hall' })
    expect(facts.property).toMatchObject({ name: 'Birch Hall', targetKey: 'birch-hall', metro: 'South Metro', nonBrandQueries: 8 })
    expect(facts.nonBrand.mention).toBe('0/24 (0.0%)')
    expect(facts.branded).toMatchObject({ mention: '4/4 (100.0%)', citation: '2/4 (50.0%)' })
    expect(facts.tie).toContain('One of 3 Properties tied')
    expect(facts.nonBrandQueries.queriesNotNamedByAnyEngine).toBe(2)
    expect(facts.nonBrandQueries.lines).toContain('quiet places near the river | gemini M-C?, openai no answer')
    expect(facts.namedInstead.top).toEqual(['Grove Tower: 6 answers, 1 queries, engines gemini/openai'])
    expect(facts.citedDomains).toMatchObject({ answers: 3, answersWithNoSources: 1, domainTotal: 2, top: ['listings.example: 2 answers', 'grovetower.example: 1 answers'] })
    const evidenceRead = requests.find(request => request.url.pathname.endsWith('/measurement-property-evidence'))
    expect(Object.fromEntries(evidenceRead!.url.searchParams)).toMatchObject({ targetKey: 'birch-hall', queryClass: 'non-brand', shape: 'answers' })
    expect(applyPlaceholders('Dig into {property}.', truth.placeholders)).toBe('Dig into Birch Hall.')
  })

  it('property-drilldown:<label> drills into the named Property instead', async () => {
    const { ctx } = stubServer('advanced', advancedRoutes)
    const truth = await buildGroundTruth('property-drilldown:Dogwood Lane', ctx)
    expect(truth.builder).toBe('property-drilldown:Dogwood Lane')
    expect(truth.placeholders).toEqual({ property: 'Dogwood Lane' })
    expect(json(truth.facts).nonBrand.mention).toBe('6/12 (50.0%)')
  })
})

describe('buildGroundTruth: simple and legacy builders', () => {
  function report(queryClass: 'all' | 'branded' | 'non-brand', rows: unknown[], nextCursor: string | null, total: number) {
    const rate = (numerator: number, denominator: number) => ({ numerator, denominator, rate: numerator / denominator })
    const population = (cls: 'branded' | 'non-brand' | 'unknown') => ({
      queryClass: cls,
      summary: {
        queryCount: cls === 'branded' ? 2 : 3,
        answerCount: cls === 'branded' ? 4 : 6,
        mentionCoverage: cls === 'branded' ? rate(4, 4) : rate(2, 6),
        citationCoverage: cls === 'branded' ? rate(3, 4) : rate(1, 6),
        propertyReach: { numerator: null, denominator: null, rate: null, reason: 'not-applicable' },
        outcomes: { bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 0 },
      },
      trend: [],
      comparison: { state: 'unavailable', reason: 'no-previous-run', previousRun: null },
      queries: { items: cls === 'non-brand' ? rows : [], nextCursor: cls === 'non-brand' ? nextCursor : null, total: cls === 'non-brand' ? total : 0 },
      evidence: { items: [], nextCursor: null, total: 0 },
      competitorAvailability: { state: 'available' },
      competitors: [{ domain: 'rival.example', answerCount: 6, mentionCoverage: rate(3, 6), citationCoverage: rate(1, 6) }],
      observedCompetitors: [{ name: 'Harbor Rival', answerCount: 2 }, { name: 'Rival Co', answerCount: 3 }],
      breakdown: { properties: [], groups: [] },
    })
    const classes = queryClass === 'all' ? ['branded', 'non-brand', 'unknown'] as const : [queryClass]
    return valid(visibilityReportResponseSchema, {
      selection: {
        mode: 'simple',
        queryClass,
        scope: { id: 'project', label: 'Project', kind: 'project', targetCount: 0 },
        provider: null,
        model: null,
        location: { kind: 'all' },
        time: { from: null, to: null },
        revision: null,
        run: { id: 'run-cur', explicit: false },
        provenance: { kind: 'frozen-simple', definitionRevision: null },
        measurement: { state: 'measured', activeRevision: null, measuredRevision: null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: COMPLETED },
        availability: { state: 'available' },
      },
      scopeOptions: [],
      filterOptions: { providers: ['gemini', 'openai'], models: [], locations: [] },
      populations: classes.map(population),
    })
  }

  function queryRow(key: string, query: string, provider: string, mentioned: number, cited: number) {
    return {
      queryKey: key,
      queryId: key,
      query,
      provider,
      model: null,
      location: null,
      targetKeys: [],
      answerCount: 1,
      mentionCoverage: { numerator: mentioned, denominator: 1, rate: mentioned },
      citationCoverage: { numerator: cited, denominator: 1, rate: cited },
    }
  }

  it('simple-query-gaps follows the report cursor and lists the queries no engine named', async () => {
    const { ctx, requests } = stubServer('simple', {
      [`${P}/runs`]: () => RUNS,
      [`${P}/visibility-report`]: url => {
        const queryClass = url.searchParams.get('queryClass') as 'branded' | 'non-brand'
        if (queryClass === 'branded') return report('branded', [], null, 0)
        if (url.searchParams.get('cursor') === 'rows-2') {
          return report('non-brand', [queryRow('q3', 'quiet cafes downtown', 'gemini', 0, 0), queryRow('q3', 'quiet cafes downtown', 'openai', 0, 1)], null, 6)
        }
        return report('non-brand', [
          queryRow('q1', 'best bakery near the park', 'gemini', 1, 1),
          queryRow('q1', 'best bakery near the park', 'openai', 1, 0),
          queryRow('q2', 'late night coffee', 'gemini', 0, 0),
          queryRow('q2', 'late night coffee', 'openai', 0, 0),
        ], 'rows-2', 6)
      },
    })
    const facts = json((await buildGroundTruth('simple-query-gaps', ctx)).facts)

    expect(requests.filter(request => request.url.searchParams.get('cursor') === 'rows-2')).toHaveLength(1)
    expect(facts.summary).toEqual({ queries: 3, answers: 6, mention: '2/6 (33.3%)', citation: '1/6 (16.7%)' })
    expect(facts.rowsRead).toBe('6 of 6 query-engine rows')
    expect(facts.queriesNeverNamed.total).toBe(2)
    expect(facts.queriesNeverNamed.lines).toEqual([
      'late night coffee | mention 0/2, citation 0/2 | gemini M-C-, openai M-C-',
      'quiet cafes downtown | mention 0/2, citation 1/2 | gemini M-C-, openai M-C+',
    ])
    expect(facts.queriesNamedByEveryAnswer).toBe(1)
    expect(facts.byEngine).toEqual({ gemini: 'mention 1/3, citation 1/3', openai: 'mention 1/3, citation 1/3' })
    expect(facts.namesWrittenInAnswers.top).toEqual(['Rival Co: 3 answers', 'Harbor Rival: 2 answers'])
    expect(facts.branded).toMatchObject({ mention: '4/4 (100.0%)' })
  })

  it('data-unavailable states what is not stored and makes no provider-facing call', async () => {
    const { ctx, requests } = stubServer('legacy', {
      [`${P}/runs`]: () => RUNS,
      [`${P}/visibility-report`]: () => report('all', [], null, 0),
    })
    const facts = json((await buildGroundTruth('data-unavailable', ctx)).facts)
    expect(facts.requestedDataAvailable).toBe(false)
    expect(facts.measuredEngines).toEqual(['gemini', 'openai'])
    expect(facts.sampledAnswersLatestSweep).toEqual([
      'branded: 4 answers over 2 queries',
      'non-brand: 6 answers over 3 queries',
      'unknown: 6 answers over 3 queries',
    ])
    expect(requests.map(request => request.url.pathname).sort()).toEqual([`/api/v1${P}/runs`, `/api/v1${P}/visibility-report`])
  })

  it('none reads nothing', async () => {
    const { ctx, requests } = stubServer('simple', {})
    const truth = await buildGroundTruth('none', ctx)
    expect(requests).toHaveLength(0)
    expect(truth.basis).toBe('No reads.')
  })
})

describe('buildGroundTruth: errors', () => {
  it('refuses an unknown builder and a builder for another project kind', async () => {
    const { ctx } = stubServer('simple', {})
    await expect(buildGroundTruth('portfolio-guess', ctx)).rejects.toThrow(/Unknown ground-truth builder "portfolio-guess"/)
    await expect(buildGroundTruth('portfolio-weakest', ctx)).rejects.toThrow(/reads advanced projects, not a simple project/)
  })

  it('fails on the primary read without echoing the API key', async () => {
    const { ctx } = stubServer('advanced', {
      [`${P}/measurement-portfolio-summary`]: () => new Response(
        JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: `bad request from Bearer ${KEY} (${KEY})` } }),
        { status: 400 },
      ),
    })
    const error = await buildGroundTruth('portfolio-weakest', ctx).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toMatch(/GET .*measurement-portfolio-summary.* HTTP 400 VALIDATION_ERROR/)
    expect(message).not.toContain(KEY)
  })
})

describe('fitFacts', () => {
  it('halves the largest lists until the facts fit, and records each cut', () => {
    const facts = {
      keep: 'small',
      rows: Array.from({ length: 400 }, (_, index) => `row ${index} ${'x'.repeat(60)}`),
      names: Array.from({ length: 40 }, (_, index) => `name ${index}`),
    }
    const fitted = fitFacts(facts, 4000) as { keep: string; rows: string[]; names: string[]; _trimmed: string[] }
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(4000)
    expect(fitted.keep).toBe('small')
    expect(fitted.rows[0]).toBe(facts.rows[0])
    expect(fitted._trimmed).toContain(`rows: kept ${fitted.rows.length} of 400`)
    expect(facts.rows).toHaveLength(400)
  })

  it('leaves facts under the cap untouched', () => {
    const facts = { rows: [1, 2, 3] }
    expect(fitFacts(facts)).toBe(facts)
  })
})

describe('question sets', () => {
  const evalDir = path.resolve(import.meta.dirname, '../eval/aero')
  const load = (file: string) => JSON.parse(fs.readFileSync(path.join(evalDir, file), 'utf8')) as EvalQuestionSet
  const sets: Array<[string, ProjectKind | null, [number, number]]> = [
    ['questions/advanced.json', 'advanced', [8, 10]],
    ['questions/simple.json', 'simple', [5, 6]],
    ['questions/legacy.json', 'legacy', [3, 3]],
    ['private-set.example.json', null, [1, 20]],
  ]
  const kinds = new Set<ProjectKind>(['advanced', 'simple', 'legacy'])

  it.each(sets)('%s is a valid set whose builders exist and apply', (file, kind, [min, max]) => {
    const set = load(file)
    expect(set.name).toMatch(/\S/)
    expect(set.questions.length).toBeGreaterThanOrEqual(min)
    expect(set.questions.length).toBeLessThanOrEqual(max)
    expect(new Set(set.questions.map(question => question.id)).size).toBe(set.questions.length)
    for (const question of set.questions) {
      expect(Object.keys(question).every(key => ['id', 'kinds', 'prompt', 'truth', 'rubric', 'lanes'].includes(key)), question.id).toBe(true)
      expect(question.kinds.length, question.id).toBeGreaterThan(0)
      expect(question.kinds.every(item => kinds.has(item)), question.id).toBe(true)
      if (kind) expect(question.kinds, question.id).toContain(kind)
      const { name } = parseBuilderRef(question.truth)
      const spec = GROUND_TRUTH_BUILDERS[name]
      expect(spec, `${question.id}: builder ${name}`).toBeDefined()
      expect(question.kinds.every(item => spec!.kinds.includes(item)), `${question.id}: ${name} kinds`).toBe(true)
      const used = [question.prompt, ...(question.rubric ?? [])].flatMap(text => [...text.matchAll(/\{([a-z]\w*)\}/gi)].map(match => match[1]))
      const provided = builderPlaceholders(question.truth)
      expect(used.every(item => provided.includes(item!)), `${question.id}: placeholders ${used.join(',')}`).toBe(true)
      expect((question.lanes ?? []).every(lane => lane === 'admin' || lane === 'viewer'), question.id).toBe(true)
    }
  })

  it('question ids are unique across the generic sets', () => {
    const ids = sets.slice(0, 3).flatMap(([file]) => load(file).questions.map(question => question.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('parses builder references with an optional argument', () => {
    expect(parseBuilderRef('sweep-changes')).toEqual({ name: 'sweep-changes' })
    expect(parseBuilderRef('property-drilldown: north-house ')).toEqual({ name: 'property-drilldown', arg: 'north-house' })
    expect(applyPlaceholders('{property} and {unknown}', { property: 'A' })).toBe('A and {unknown}')
  })
})
