/**
 * The portfolio summary is read by an agent through a 20,000-character
 * tool-result cap, serialized as indented JSON. A result over the cap is cut
 * mid-row, and the agent then reports on rows, markets and sources it never
 * saw. This builds a portfolio at the scale where that happened (200
 * Properties, 150 nested markets, 3 engines, a 70-way tie at zero) and holds
 * the default response under the cap with every per-row list filled.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT,
  buildMeasurementExecutionIdentity,
  canonicalMeasurementPlanV2Json,
  measurementPlanV2Schema,
  type MeasurementPlanV2,
  type MeasurementPortfolioSummaryResponse,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'
import { HARBOR_CONTEXT } from './measurement-plan-v2-fixture.js'

/** What the agent runtime keeps of one tool result. */
const TOOL_RESULT_CAP = 20_000
const NOW = '2026-08-02T12:00:00.000Z'
const PROVIDERS = ['openai', 'gemini', 'claude'] as const
const PROPERTY_COUNT = 200
const METRO_COUNT = 20
const SUBMARKETS_PER_METRO = 6.5
const TIED_AT_ZERO = 70

const PREFIXES = ['Harbor', 'Cedar', 'Maple', 'Willow', 'Summit', 'Lakeside', 'Riverbend', 'Oakridge', 'Stonegate', 'Brookside']
const SUFFIXES = ['Homes', 'Residences', 'Commons', 'Lofts', 'Place', 'Flats', 'Terrace', 'Village', 'Gardens', 'Crossing']
const AREAS = ['Old Town', 'Cedar Park', 'Mill District', 'North Shore', 'Uptown', 'West End', 'Canal Street', 'Hillcrest', 'Southgate', 'Fairview', 'Elm Grove', 'Bayfront', 'Midtown']
const METROS = ['Riverbend', 'Lakeshore', 'Pine Valley', 'Coral Bay', 'Granite Falls', 'Silver Lake', 'Red Mesa', 'Blue Ridge', 'Clearwater', 'Ashford',
  'Kingsport', 'Marlow', 'Northfield', 'Oak Harbor', 'Prairie View', 'Queensbury', 'Rockport', 'Sandpoint', 'Thornbury', 'Westbrook']
/** Listing, review and forum hosts: most answers cite several, whatever they name. */
const SOURCE_DOMAINS = Array.from({ length: 40 }, (_, index) => `${['rentals', 'listings', 'homefinder', 'reviews', 'aptguide', 'localforum', 'citybeat', 'movehub'][index % 8]}-${index}.example`)
/** Other operators' communities an answer writes in place of the Property. */
const OTHER_NAMES = Array.from({ length: 150 }, (_, index) => `${['Parkview', 'Lumen', 'Arbor', 'Vista', 'Beacon', 'Atlas'][index % 6]} ${['Towers', 'Flats', 'Station', 'Commons', 'Point'][index % 5]} (${AREAS[index % AREAS.length]})`)

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Deterministic, so the measured size never drifts between runs. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

function pick<T>(values: readonly T[], count: number, next: () => number): T[] {
  const chosen = new Set<T>()
  while (chosen.size < Math.min(count, values.length)) chosen.add(values[Math.floor(next() * values.length)]!)
  return [...chosen]
}

interface PortfolioFixture {
  plan: MeasurementPlanV2
  queryCount: Map<string, number>
}

function largePortfolio(): PortfolioFixture {
  const targets: MeasurementPlanV2['targets'] = []
  const groups: MeasurementPlanV2['groups'] = []
  const querySnapshotsInPlan: MeasurementPlanV2['querySnapshots'] = []
  const assignments: MeasurementPlanV2['assignments'] = []
  const executionNodes: MeasurementPlanV2['executionNodes'] = []
  const usageEdges: MeasurementPlanV2['usageEdges'] = []
  const queryCount = new Map<string, number>()

  for (let index = 0; index < PROPERTY_COUNT; index++) {
    const label = `${PREFIXES[index % 10]} ${SUFFIXES[Math.floor(index / 10) % 10]} ${String(index).padStart(3, '0')}`
    const stableKey = slug(label)
    targets.push({
      stableKey,
      label,
      aliases: [label],
      urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: `/locations/${stableKey}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    })
    // Roughly a third of Properties carry 8 queries, the rest 4.
    const queries = index % 3 === 0 ? 8 : 4
    queryCount.set(stableKey, queries)
    for (let q = 0; q < queries; q++) {
      const queryId = `q-${stableKey}-${q}`
      const queryText = `best apartments near ${AREAS[(index + q) % AREAS.length]} for ${['families', 'students', 'young professionals', 'pet owners'][q % 4]} #${index}`
      const executionNodeKey = `exec-${stableKey}-${q}`
      querySnapshotsInPlan.push({ queryId, queryText, provenance: { source: 'manual', sourceId: null, capturedAt: '2026-07-01T00:00:00.000Z' } })
      assignments.push({ targetKey: stableKey, queryId, queryClass: 'non-brand', executionNodeKey })
      executionNodes.push({
        stableKey: executionNodeKey,
        queryId,
        queryText,
        context: { providers: [...PROVIDERS], models: {}, location: HARBOR_CONTEXT },
        expectedSnapshots: PROVIDERS.length,
      })
      usageEdges.push({ executionNodeKey, targetKey: stableKey, queryId })
    }
  }

  // 20 metros of 10 Properties each, and 130 submarkets inside them. Every
  // Property sits in one submarket; a third also sit in a second.
  const submarketTotal = Math.round(METRO_COUNT * SUBMARKETS_PER_METRO)
  for (let metro = 0; metro < METRO_COUNT; metro++) {
    const members = targets.slice(metro * 10, metro * 10 + 10).map(target => target.stableKey)
    const metroKey = `${slug(METROS[metro]!)}-metro-area`
    groups.push({ stableKey: metroKey, label: `${METROS[metro]} Metro Area`, targetKeys: members, competitors: [] })
    const submarkets = Math.floor(((metro + 1) * submarketTotal) / METRO_COUNT) - Math.floor((metro * submarketTotal) / METRO_COUNT)
    for (let sub = 0; sub < submarkets; sub++) {
      const area = AREAS[(metro + sub) % AREAS.length]!
      const subMembers = members.filter((_, position) => position % submarkets === sub || (position % 3 === 0 && (position + 1) % submarkets === sub))
      groups.push({
        stableKey: `${metroKey}--${slug(area)}-${sub}`,
        label: `${area}, ${METROS[metro]} Metro`,
        parentGroupKey: metroKey,
        targetKeys: subMembers,
        competitors: [],
      })
    }
  }

  const plan = measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'northstar.example', ownedHosts: ['northstar.example'], names: ['Northstar'] } },
    targets,
    groups,
    querySnapshots: querySnapshotsInPlan,
    assignments,
    executionNodes,
    usageEdges,
    compiledChecksum: 'c'.repeat(64),
  })
  return { plan, queryCount }
}

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let fixture: PortfolioFixture

function seedLargeRun(): void {
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'northstar', displayName: 'Northstar', canonicalDomain: 'northstar.example',
    ownedDomains: ['northstar.example'], country: 'US', language: 'en', locations: [], providers: [],
    createdAt: NOW, updatedAt: NOW,
  }).run()
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId, projectId, revision: 1,
    canonicalJson: canonicalMeasurementPlanV2Json(fixture.plan),
    checksum: 'd'.repeat(64), schemaVersion: 2, compiledChecksum: fixture.plan.compiledChecksum, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
    measurementPlanVersionId: versionId,
    measurementManifest: buildMeasurementPlanV2Manifest(fixture.plan),
    measurementExecutionIdentity: buildMeasurementExecutionIdentity({
      providers: [...PROVIDERS], models: { openai: 'gpt-measurement', gemini: 'gemini-measurement', claude: 'claude-measurement' },
    }, 'e'.repeat(64)),
    finishedAt: NOW, createdAt: NOW,
  }).run()

  const next = random(20260924)
  const labels = new Map(fixture.plan.targets.map(target => [target.stableKey, target.label]))
  // The first 70 Properties in label order are never named or cited.
  const tied = new Set([...fixture.plan.targets].sort((a, b) => a.label.localeCompare(b.label)).slice(0, TIED_AT_ZERO).map(target => target.stableKey))
  const rows: Array<typeof querySnapshots.$inferInsert> = []
  for (const assignment of fixture.plan.assignments) {
    const node = fixture.plan.executionNodes.find(candidate => candidate.stableKey === assignment.executionNodeKey)!
    for (const provider of PROVIDERS) {
      const zero = tied.has(assignment.targetKey)
      const mentioned = !zero && next() < 0.45
      const cited = mentioned && next() < 0.5
      const domains = pick(SOURCE_DOMAINS, 6 + Math.floor(next() * 5), next)
      rows.push({
        id: crypto.randomUUID(),
        runId,
        queryId: null,
        queryText: node.queryText,
        provider,
        citationState: cited ? 'cited' : 'not-cited',
        answerMentioned: mentioned,
        answerText: mentioned
          ? `${labels.get(assignment.targetKey)} is a strong option, alongside a few others nearby.`
          : 'Several other communities nearby are worth a look.',
        citedDomains: cited ? [...domains, 'northstar.example'] : domains,
        citedUrls: cited ? [`https://northstar.example/locations/${assignment.targetKey}`] : domains.map(domain => `https://${domain}/listing`),
        captureStatus: 'complete',
        competitorOverlap: [],
        recommendedCompetitors: mentioned ? [] : pick(OTHER_NAMES, 4 + Math.floor(next() * 4), next),
        measurementExecutionId: node.stableKey,
        requestedContext: node.context.location,
        supportedContext: { status: 'applied', resolved: node.context.location },
        location: node.context.location?.label ?? null,
        retrievalStatus: 'used',
        retrievalContract: 'native-auto-v1',
        createdAt: NOW,
      })
    }
  }
  for (let start = 0; start < rows.length; start += 400) {
    db.insert(querySnapshots).values(rows.slice(start, start + 400)).run()
  }
}

async function summary(query = ''): Promise<{ status: number; body: MeasurementPortfolioSummaryResponse; text: string }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/measurement-portfolio-summary${query === '' ? '' : `?${query}`}`,
  })
  const body = response.json() as MeasurementPortfolioSummaryResponse
  // Exactly what the agent runtime serializes before applying its cap.
  return { status: response.statusCode, body, text: JSON.stringify(body, null, 2) }
}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-portfolio-size-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  fixture = largePortfolio()
  seedLargeRun()
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('portfolio summary size at portfolio scale', () => {
  it('builds a fixture at the scale that overflowed', () => {
    expect(fixture.plan.targets).toHaveLength(PROPERTY_COUNT)
    expect(fixture.plan.groups).toHaveLength(150)
    expect(fixture.plan.groups.filter(group => group.parentGroupKey === undefined)).toHaveLength(METRO_COUNT)
  })

  it('answers worst Properties, names written instead and cited sources in one default read under the cap', async () => {
    const { status, body, text } = await summary()
    expect(status).toBe(200)
    expect(text.length).toBeLessThan(TOOL_RESULT_CAP)

    // The size holds with every list the agent needs actually filled.
    expect(body.weakestProperties).toHaveLength(MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT)
    for (const row of body.weakestProperties) {
      expect(row.metro?.label).toMatch(/ Metro Area$/)
      expect(row.submarkets.length).toBeGreaterThan(0)
      expect(row.queries).toBe(fixture.queryCount.get(row.targetKey))
      // 3 engines per query, so every denominator is queries x 3 answers.
      expect(row.mentionCoverage).toMatchObject({ state: 'available', numerator: 0, denominator: row.queries * 3 })
      expect(row.namedInsteadInAnswerText).toHaveLength(5)
      expect(row.citedDomains).toHaveLength(5)
    }
    expect(body.engines).toEqual(['claude', 'gemini', 'openai'])
    expect(body.tiedAtWeakest).toMatchObject({ count: TIED_AT_ZERO, mentionRate: 0, citationRate: 0 })
    expect(body.weakestAnswerSources).toMatchObject({ properties: TIED_AT_ZERO })
    expect(body.weakestAnswerSources?.domains).toHaveLength(10)
    expect(body.mentionRanking.strongest).toHaveLength(MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT)
    expect(body.mentionRanking.weakest).toHaveLength(MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT)
    expect(body.markets).toHaveLength(MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT)
    expect(body.markets.every(market => market.parentGroupKey === null)).toBe(true)
    expect(body).toMatchObject({ totalMarkets: METRO_COUNT, marketsTruncated: true, totalProperties: PROPERTY_COUNT, truncated: true })
  })

  it('drills into one metro under the cap, listing its submarkets', async () => {
    const metro = fixture.plan.groups.find(group => group.parentGroupKey === undefined)!
    const { status, body, text } = await summary(`groupKey=${metro.stableKey}`)
    expect(status).toBe(200)
    expect(text.length).toBeLessThan(TOOL_RESULT_CAP)
    expect(body.markets.length).toBeGreaterThan(0)
    expect(body.markets.every(market => market.parentGroupKey === metro.stableKey)).toBe(true)
  })

  it('keeps every market reachable when asked, uncapped', async () => {
    const { status, body } = await summary('includeNestedMarkets=true')
    expect(status).toBe(200)
    expect(body.markets).toHaveLength(150)
    expect(body).toMatchObject({ totalMarkets: 150, marketsTruncated: false })
  })
})
