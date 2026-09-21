import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  type MeasurementPlanV2,
  type VisibilityReportResponse,
  type VisibilityReportScopeOption,
} from '@ainyc/canonry-contracts'
import {
  apiKeys,
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { planScopeOptions } from '../src/measurement-scope-options.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-09-01T12:00:00.000Z'
const READ_KEY = 'cnry_scope_options_reader'

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string

/**
 * Three Properties, a nested Group, and three markets, authored in the stored
 * (canonical, key-sorted) order so the route and the builder read one order:
 * - `coast-market` has no Group link and spans two Properties;
 * - `harbor-market` links to `waterfront` and holds two edges to one Property (Harbor Homes);
 * - `metro-market` links to `metro`.
 * Pier Lofts belongs to no Group and no market.
 */
function scopeOptionsPlan(): MeasurementPlanV2 {
  const base = measurementPlanV2Fixture()
  const target = (stableKey: string) => base.targets.find(candidate => candidate.stableKey === stableKey)!
  return measurementPlanV2Fixture({
    targets: [
      target('bayside'),
      target('harbor'),
      {
        stableKey: 'pier',
        label: 'Pier Lofts',
        aliases: ['Pier Lofts'],
        urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/pier', pathCase: 'insensitive' }],
        mentionNotApplicable: false,
        discoveryIdentity: null,
      },
    ],
    groups: [
      { stableKey: 'metro', label: 'Metro', targetKeys: ['harbor', 'bayside'], competitors: [] },
      { stableKey: 'waterfront', label: 'Waterfront', parentGroupKey: 'metro', targetKeys: ['harbor'], competitors: [] },
    ],
    reportingScopes: [
      {
        stableKey: 'coast-market', label: 'Coast market', kind: 'market',
        usageEdges: [
          { executionNodeKey: 'exec-nearby', targetKey: 'bayside', queryId: 'q-nearby' },
          { executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' },
        ],
      },
      {
        stableKey: 'harbor-market', label: 'Harbor market', kind: 'market', groupKey: 'waterfront',
        usageEdges: [
          { executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-brand' },
          { executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' },
        ],
      },
      {
        stableKey: 'metro-market', label: 'Metro market', kind: 'market', groupKey: 'metro',
        usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'bayside', queryId: 'q-nearby' }],
      },
    ],
  })
}

/** Today's report scope options for `scopeOptionsPlan()`, captured before the builder moved. */
const REPORT_SCOPE_OPTIONS: VisibilityReportScopeOption[] = [
  { id: 'project', label: 'Project', kind: 'project', targetCount: 3 },
  { id: 'metro', label: 'Metro', kind: 'group', targetCount: 2, marketKeys: ['metro-market'] },
  { id: 'waterfront', label: 'Waterfront', kind: 'group', targetCount: 1, parentGroupIds: ['metro'], marketKeys: ['harbor-market'] },
  { id: 'coast-market', label: 'Coast market', kind: 'market', targetCount: 2 },
  { id: 'harbor-market', label: 'Harbor market', kind: 'market', targetCount: 1, parentGroupIds: ['waterfront'] },
  { id: 'metro-market', label: 'Metro market', kind: 'market', targetCount: 1, parentGroupIds: ['metro'] },
  {
    id: 'bayside', label: 'Bayside Homes', kind: 'property', targetCount: 1,
    parentGroupIds: ['metro'], marketKeys: ['coast-market', 'metro-market'],
  },
  {
    id: 'harbor', label: 'Harbor Homes', kind: 'property', targetCount: 1,
    parentGroupIds: ['metro', 'waterfront'], marketKeys: ['coast-market', 'harbor-market'],
  },
  { id: 'pier', label: 'Pier Lofts', kind: 'property', targetCount: 1, parentGroupIds: [] },
]

function activatePlan(plan: MeasurementPlanV2): void {
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision: 1,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: 'c'.repeat(64),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    comparableToVersionId: null,
    createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW }).run()
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-report-scope-options-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'northstar.example',
    country: 'US', language: 'en',
    createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'scope options reader',
    keyHash: hashApiKey(READ_KEY),
    keyPrefix: READ_KEY.slice(0, 9),
    scopes: ['read'],
    projectId,
    createdAt: NOW,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('visibility report scope options', () => {
  it('returns the frozen v2 scope options with exact distinct counts, parents, and market links', async () => {
    activatePlan(scopeOptionsPlan())
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northstar/visibility-report?queryClass=non-brand',
      headers: { authorization: `Bearer ${READ_KEY}` },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect((response.json() as VisibilityReportResponse).scopeOptions).toStrictEqual(REPORT_SCOPE_OPTIONS)
  })
})

/** The same plan without market links, as query tracking reads it. */
const UNLINKED_SCOPE_OPTIONS: VisibilityReportScopeOption[] = [
  { id: 'project', label: 'Project', kind: 'project', targetCount: 3 },
  { id: 'metro', label: 'Metro', kind: 'group', targetCount: 2 },
  { id: 'waterfront', label: 'Waterfront', kind: 'group', targetCount: 1, parentGroupIds: ['metro'] },
  { id: 'coast-market', label: 'Coast market', kind: 'market', targetCount: 2 },
  { id: 'harbor-market', label: 'Harbor market', kind: 'market', targetCount: 1, parentGroupIds: ['waterfront'] },
  { id: 'metro-market', label: 'Metro market', kind: 'market', targetCount: 1, parentGroupIds: ['metro'] },
  { id: 'bayside', label: 'Bayside Homes', kind: 'property', targetCount: 1, parentGroupIds: ['metro'] },
  { id: 'harbor', label: 'Harbor Homes', kind: 'property', targetCount: 1, parentGroupIds: ['metro', 'waterfront'] },
  { id: 'pier', label: 'Pier Lofts', kind: 'property', targetCount: 1, parentGroupIds: [] },
]

describe('planScopeOptions', () => {
  it('with market links reproduces the report scope options exactly', () => {
    expect(planScopeOptions(scopeOptionsPlan(), { marketLinks: true })).toStrictEqual(REPORT_SCOPE_OPTIONS)
  })

  it('without market links drops marketKeys from Groups and Properties and keeps market parents', () => {
    const options = planScopeOptions(scopeOptionsPlan(), { marketLinks: false })
    expect(options).toStrictEqual(UNLINKED_SCOPE_OPTIONS)
    expect(options.filter(option => 'marketKeys' in option)).toStrictEqual([])
    // Only the links differ: ids, labels, kinds, distinct counts, and parents match the report.
    expect(options).toStrictEqual(REPORT_SCOPE_OPTIONS.map(option => {
      const unlinked = { ...option }
      delete unlinked.marketKeys
      return unlinked
    }))
  })
})
