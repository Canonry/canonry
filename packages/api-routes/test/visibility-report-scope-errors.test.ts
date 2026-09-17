import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  parseVisibilityReportScopeErrorDetails,
  type VisibilityReportScopeErrorDetails,
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
import type { VisibilityReportDefinitionInput, VisibilityReportReaderInput } from '../src/visibility-report-reader.js'

type DefinitionOverride = (definition: VisibilityReportDefinitionInput) => VisibilityReportDefinitionInput

/**
 * The real reader, with an optional rewrite of the frozen definitions it
 * receives. A consistent frozen plan lists a Group in its scope options exactly
 * when its membership lists it, so only a rewritten definition reaches the two
 * Group-membership throw sites. Everything else stays the real route.
 */
const reader = vi.hoisted(() => ({ override: null as DefinitionOverride | null }))

vi.mock('../src/visibility-report-reader.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/visibility-report-reader.js')>()
  return {
    ...actual,
    buildVisibilityReport: (input: VisibilityReportReaderInput) => {
      const override = reader.override
      return actual.buildVisibilityReport(override === null ? input : {
        ...input,
        activeDefinition: override(input.activeDefinition),
        runs: input.runs.map(run => ({ ...run, definition: override(run.definition) })),
      })
    },
  }
})

import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-09-01T12:00:00.000Z'
const READ_KEY = 'cnry_scope_errors_reader'

let directory: string
let db: DatabaseClient
let app: FastifyInstance
let projectId: string

async function report(query: string): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/projects/northstar/visibility-report?${query}`,
    headers: { authorization: `Bearer ${READ_KEY}` },
  })
  return { status: response.statusCode, body: response.json() as unknown }
}

/** Drop the project option, which every consistent frozen definition has. */
function withoutProjectScope(): DefinitionOverride {
  return definition => ({ ...definition, scopeOptions: definition.scopeOptions.filter(option => option.kind !== 'project') })
}

/** Drop a Group from frozen membership while its scope option remains. */
function withoutGroupMembership(groupKey: string): DefinitionOverride {
  return definition => ({ ...definition, groups: definition.groups.filter(group => group.id !== groupKey) })
}

/**
 * Membership that answers only a lookup paired with a scope-option read.
 * `scopeResolution` pairs its Group lookup with one, so the scope resolves;
 * `scopeTargetKeys` then re-reads membership with no scope-option read in
 * between. Plain frozen arrays answer both reads identically, which is why the
 * second site needs this rewrite to be observable at all.
 */
function membershipLostAfterScopeResolution(): DefinitionOverride {
  return definition => {
    let paired = false
    return {
      ...definition,
      get scopeOptions() {
        paired = true
        return definition.scopeOptions
      },
      get groups() {
        const groups = paired ? definition.groups : []
        paired = false
        return groups
      },
    }
  }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-report-scope-errors-'))
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
    name: 'scope errors reader',
    keyHash: hashApiKey(READ_KEY),
    keyPrefix: READ_KEY.slice(0, 9),
    scopes: ['read'],
    projectId,
    createdAt: NOW,
  }).run()
  // Frozen definition: Properties harbor + bayside, Group regional, market harbor-market.
  const plan = measurementPlanV2Fixture({
    reportingScopes: [{
      stableKey: 'harbor-market', label: 'Harbor market', kind: 'market', groupKey: 'regional',
      usageEdges: [{ executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' }],
    }],
  })
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
  app = Fastify()
  app.register(apiRoutes, { db })
  await app.ready()
})

afterEach(async () => {
  reader.override = null
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

function expectRetiredScopeError(
  result: { status: number; body: unknown },
  message: string,
  details: VisibilityReportScopeErrorDetails,
): void {
  expect(result.status).toBe(400)
  expect(result.body).toStrictEqual({ error: { code: 'VALIDATION_ERROR', message, details } })
  // The served details are exactly what the shared client parser accepts.
  expect(parseVisibilityReportScopeErrorDetails((result.body as { error: { details: unknown } }).error.details)).toStrictEqual(details)
}

describe('visibility report retired-scope errors', () => {
  it.each([
    {
      name: 'a retired Property scope',
      query: 'queryClass=non-brand&scope=property&scopeKey=retired-property',
      message: 'property scope "retired-property" is not in this frozen definition.',
      details: { reason: 'retired-scope', kind: 'property', key: 'retired-property' },
    },
    {
      name: 'a retired Group scope',
      query: 'queryClass=non-brand&scope=group&scopeKey=retired-group',
      message: 'group scope "retired-group" is not in this frozen definition.',
      details: { reason: 'retired-scope', kind: 'group', key: 'retired-group' },
    },
    {
      name: 'a retired market scope',
      query: 'queryClass=non-brand&scope=market&scopeKey=retired-market-scope',
      message: 'market scope "retired-market-scope" is not in this frozen definition.',
      details: { reason: 'retired-scope', kind: 'market', key: 'retired-market-scope' },
    },
    {
      name: 'a retired market refinement on a live Group',
      query: 'queryClass=non-brand&scope=group&scopeKey=regional&marketKey=retired-market',
      message: 'Market "retired-market" is not in this frozen definition.',
      details: { reason: 'retired-market', kind: 'market', key: 'retired-market' },
    },
    {
      name: 'a retired market refinement on a live Property',
      query: 'queryClass=non-brand&scope=property&scopeKey=harbor&marketKey=retired-market',
      message: 'Market "retired-market" is not in this frozen definition.',
      details: { reason: 'retired-market', kind: 'market', key: 'retired-market' },
    },
  ] satisfies Array<{ name: string; query: string; message: string; details: VisibilityReportScopeErrorDetails }>)(
    'types $name as $details.reason with its kind and key',
    async ({ query, message, details }) => {
      expectRetiredScopeError(await report(query), message, details)
    },
  )

  it('types a Group missing from frozen membership at the scope-resolution site', async () => {
    reader.override = withoutGroupMembership('regional')
    expectRetiredScopeError(
      await report('queryClass=non-brand&scope=group&scopeKey=regional'),
      'Group "regional" is not in this frozen definition.',
      { reason: 'retired-scope', kind: 'group', key: 'regional' },
    )
  })

  it('types a Group lost between scope resolution and its Property population read', async () => {
    reader.override = membershipLostAfterScopeResolution()
    expectRetiredScopeError(
      await report('queryClass=non-brand&scope=group&scopeKey=regional'),
      'Group "regional" is not in this frozen definition.',
      { reason: 'retired-scope', kind: 'group', key: 'regional' },
    )
  })

  it('serves the live Group when its frozen membership is intact', async () => {
    const result = await report('queryClass=non-brand&scope=group&scopeKey=regional')
    expect(result.status).toBe(200)
  })

  it.each([
    {
      // The same scope-error class as a retired scope, without a retired key.
      name: 'a frozen definition with no project scope',
      override: withoutProjectScope(),
      query: 'queryClass=non-brand',
      message: 'Frozen definition has no project scope.',
    },
    {
      name: 'a malformed cursor',
      override: null,
      query: 'queryClass=non-brand&cursor=not-a-cursor',
      message: 'Visibility report cursor is invalid.',
    },
  ])('returns no details for $name, which is not a retired scope', async ({ override, query, message }) => {
    reader.override = override
    const result = await report(query)
    expect(result.status).toBe(400)
    expect(result.body).toStrictEqual({ error: { code: 'VALIDATION_ERROR', message } })
  })
})
