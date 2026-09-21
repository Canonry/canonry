import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  queryTrackingWorkspaceResponseSchema,
  visibilityReportScopeOptionSchema,
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
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-09-04T00:00:00.000Z'
const PROJECT_ID = 'project-northstar'
// A read-only key: the workspace read carries no write gate.
const READ_KEY = 'cnry_tracking_scope_reader'

let directory: string
let db: DatabaseClient
let app: FastifyInstance

/**
 * Three Properties, a nested Group, and three markets, in stored (key-sorted) order:
 * `coast-market` spans two Properties with no Group link, `harbor-market` links
 * to `waterfront` through two edges to one Property, and `metro-market` links to
 * `metro`. Pier Lofts belongs to no Group and no market.
 */
function publishedPlan(): MeasurementPlanV2 {
  const base = measurementPlanV2Fixture()
  const target = (stableKey: string) => base.targets.find(candidate => candidate.stableKey === stableKey)!
  const draft = measurementPlanV2Fixture({
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
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex')
  return measurementPlanV2Schema.parse({ ...draft, compiledChecksum })
}

const TRACKING_SCOPE_OPTIONS: VisibilityReportScopeOption[] = [
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

function activate(plan: MeasurementPlanV2): void {
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  db.insert(measurementPlanVersions).values({
    id: 'plan-v1', projectId: PROJECT_ID, revision: 1, canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'), schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum, comparableToVersionId: null, createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId: PROJECT_ID, activeVersionId: 'plan-v1', createdAt: NOW, updatedAt: NOW }).run()
}

/** The served JSON, deliberately unparsed, so a schema default cannot stand in for the server. */
async function read(pathName: string): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar${pathName}`,
    headers: { authorization: `Bearer ${READ_KEY}` },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Record<string, unknown>
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-tracking-scope-options-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: PROJECT_ID, name: 'northstar', displayName: 'Northstar', canonicalDomain: 'northstar.example',
    ownedDomains: [], aliases: [], country: 'US', language: 'en', providers: [], providerModels: {},
    locations: [], defaultLocation: null, createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'tracking scope reader', keyHash: hashApiKey(READ_KEY), keyPrefix: READ_KEY.slice(0, 9),
    scopes: ['read'], projectId: PROJECT_ID, createdAt: NOW,
  }).run()
  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('query tracking workspace scope options', () => {
  it('builds Advanced options from the active plan with exact distinct counts and no market links', async () => {
    activate(publishedPlan())
    const body = await read('/query-tracking')
    expect(body.mode).toBe('advanced')
    expect(body.scopeOptions).toStrictEqual(TRACKING_SCOPE_OPTIONS)
    const options = body.scopeOptions as VisibilityReportScopeOption[]
    expect(options
      .filter(option => option.kind === 'group' || option.kind === 'market')
      .map(option => [option.kind, option.id, option.targetCount])).toStrictEqual([
      ['group', 'metro', 2],
      ['group', 'waterfront', 1],
      ['market', 'coast-market', 2],
      // Two edges to Harbor Homes count one Property.
      ['market', 'harbor-market', 1],
      ['market', 'metro-market', 1],
    ])
    expect(options.filter(option => 'marketKeys' in option)).toStrictEqual([])
  })

  it('matches the report options for the same plan in everything but market links', async () => {
    activate(publishedPlan())
    const workspace = await read('/query-tracking')
    const report = await read('/visibility-report?queryClass=non-brand') as unknown as VisibilityReportResponse
    expect(report.scopeOptions.filter(option => option.marketKeys !== undefined).map(option => option.id))
      .toStrictEqual(['metro', 'waterfront', 'bayside', 'harbor'])
    expect(workspace.scopeOptions).toStrictEqual(report.scopeOptions.map(option => {
      const unlinked = { ...option }
      delete unlinked.marketKeys
      return unlinked
    }))
  })

  it('returns exactly the project option for a Simple project, as the Simple report does', async () => {
    const workspace = await read('/query-tracking')
    expect(workspace.mode).toBe('simple')
    expect(workspace.scopeOptions).toStrictEqual([{ id: 'project', label: 'Project', kind: 'project', targetCount: 1 }])
    const report = await read('/visibility-report?queryClass=non-brand') as unknown as VisibilityReportResponse
    expect(workspace.scopeOptions).toStrictEqual(report.scopeOptions)
  })

  it.each([
    { name: 'Advanced', seed: () => activate(publishedPlan()) },
    { name: 'Simple', seed: () => undefined },
  ])('serves $name options that validate against the workspace contract unchanged', async ({ seed }) => {
    seed()
    const body = await read('/query-tracking')
    expect(z.array(visibilityReportScopeOptionSchema).safeParse(body.scopeOptions).success).toBe(true)
    const parsed = queryTrackingWorkspaceResponseSchema.parse(body)
    expect(parsed.scopeOptions).toStrictEqual(body.scopeOptions)
  })
})
