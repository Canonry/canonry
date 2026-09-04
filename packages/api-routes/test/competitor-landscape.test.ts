import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  competitors,
  createClient,
  domainClassifications,
  migrate,
  measurementPlans,
  measurementPlanDrafts,
  measurementPlanVersions,
  projects,
  queries,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  canonicalMeasurementPlanV2Json,
  competitorLandscapeResponseSchema,
  measurementPlanV2Schema,
} from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

const NOW = '2026-08-20T12:00:00.000Z'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-competitor-landscape-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(projects).values({
    id: 'project_northwind',
    name: 'northwind',
    displayName: 'Northwind',
    canonicalDomain: 'northwind.example',
    ownedDomains: ['shop.northwind.example'],
    country: 'US',
    language: 'en',
    providers: ['openai'],
    locations: [],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(competitors).values({
    id: 'pinned_rival',
    projectId: 'project_northwind',
    domain: 'rival.example',
    provenance: 'manual',
    createdAt: NOW,
  }).run()
  db.insert(queries).values({
    id: 'market-query',
    projectId: 'project_northwind',
    query: 'homes near northwind',
    createdAt: NOW,
  }).run()
  db.insert(domainClassifications).values([
    {
      id: crypto.randomUUID(),
      projectId: 'project_northwind',
      domain: 'challenger.example',
      competitorType: 'direct-competitor',
      hits: 2,
      sessionId: null,
      updatedAt: NOW,
    },
    {
      id: crypto.randomUUID(),
      projectId: 'project_northwind',
      domain: 'guide.example',
      competitorType: 'editorial-media',
      hits: 1,
      sessionId: null,
      updatedAt: NOW,
    },
  ]).run()
  db.insert(runs).values([
    {
      id: 'run_normal',
      projectId: 'project_northwind',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      location: null,
      createdAt: NOW,
    },
    {
      id: 'run_probe',
      projectId: 'project_northwind',
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'probe',
      location: null,
      createdAt: NOW,
    },
    {
      id: 'run_failed',
      projectId: 'project_northwind',
      kind: 'answer-visibility',
      status: 'failed',
      trigger: 'manual',
      location: null,
      createdAt: NOW,
    },
  ]).run()
  db.insert(querySnapshots).values([
    {
      id: 'snapshot_answer',
      runId: 'run_normal',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: true,
      answerText: 'Northwind, Rival, and Challenger are all relevant choices.',
      citedDomains: ['rival.example', 'challenger.example', 'guide.example'],
      citedUrls: ['https://guide.example/overview'],
      captureStatus: 'complete',
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    },
    {
      id: 'snapshot_source_only',
      runId: 'run_normal',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: null,
      answerText: null,
      citedDomains: ['rival.example'],
      citedUrls: null,
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    },
    {
      id: 'snapshot_probe',
      runId: 'run_probe',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Probe Rival',
      citedDomains: ['rival.example'],
      citedUrls: null,
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    },
    {
      id: 'snapshot_failed',
      runId: 'run_failed',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited',
      answerMentioned: false,
      answerText: 'Failed Rival result',
      citedDomains: ['rival.example'],
      citedUrls: null,
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    },
  ]).run()

  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('GET /projects/:name/analytics/competitors', () => {
  it('returns probe-excluded stored answer and citation evidence with pinned rows first', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all',
    })

    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(competitorLandscapeResponseSchema.safeParse(body).success).toBe(true)
    expect(body).toMatchObject({
      window: 'all',
      scope: { kind: 'project' },
      evidence: {
        answeredResults: 1,
        sourceResults: 2,
        missingAnswerTextResults: 1,
        mentionCredits: 3,
        incompleteSourceResults: 1,
        excludedProbeResults: 1,
        excludedNonCompletedResults: 1,
      },
    })
    expect(body.project).toMatchObject({ domain: 'northwind.example', mentionCount: 1, shareOfVoice: 33.3 })
    expect(body.pinned).toEqual([expect.objectContaining({
      domain: 'rival.example',
      pinned: true,
      mentionCount: 1,
      shareOfVoice: 33.3,
      citationCount: 2,
    })])
    expect(body.observed).toEqual([expect.objectContaining({
      domain: 'challenger.example',
      pinned: false,
      mentionCount: 1,
      shareOfVoice: 33.3,
      citationCount: 1,
    })])
    expect(body.otherSources).toEqual([expect.objectContaining({
      domain: 'guide.example',
      surfaceClass: 'editorial-media',
      shareOfVoice: null,
      citationCount: 1,
    })])
  })

  it('uses the run creation timestamp for rolling windows', async () => {
    const now = new Date().toISOString()
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    db.insert(runs).values([
      {
        id: 'window_current_run',
        projectId: 'project_northwind',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        location: null,
        createdAt: now,
      },
      {
        id: 'window_old_run',
        projectId: 'project_northwind',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        location: null,
        createdAt: old,
      },
    ]).run()
    db.insert(querySnapshots).values([
      marketSnapshot('window_current_snapshot', 'window_current_run', null, 'Northwind and Rival.', 'rival.example', now),
      marketSnapshot('window_old_snapshot', 'window_old_run', null, 'Northwind and Rival.', 'rival.example', old),
    ]).run()

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=7d',
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      window: '7d',
      evidence: { answeredResults: 1 },
      pinned: [expect.objectContaining({ domain: 'rival.example', mentionCount: 1 })],
    })
  })

  it('caps ranked observed and other source rows deterministically without dropping pins', async () => {
    const ranked = Array.from({ length: 101 }, (_, index) => String(index).padStart(3, '0'))
    db.insert(domainClassifications).values(ranked.map(index => ({
      id: crypto.randomUUID(),
      projectId: 'project_northwind',
      domain: `ranked-${index}.example`,
      competitorType: 'direct-competitor',
      hits: 1,
      sessionId: null,
      updatedAt: NOW,
    }))).run()
    db.insert(querySnapshots).values(ranked.map(index => ({
      id: `ranked-source-${index}`,
      runId: 'run_normal',
      queryId: null,
      provider: 'openai',
      citationState: 'not-cited' as const,
      answerMentioned: null,
      answerText: null,
      citedDomains: [`ranked-${index}.example`, `source-${index}.example`],
      citedUrls: null,
      captureStatus: 'complete' as const,
      competitorOverlap: [],
      location: null,
      createdAt: NOW,
    }))).run()

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all',
    })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ truncated: true })
    expect(body.pinned.map((row: { domain: string }) => row.domain)).toEqual(['rival.example'])
    expect(body.observed).toHaveLength(100)
    expect(body.otherSources).toHaveLength(100)
    expect(body.observed.map((row: { domain: string }) => row.domain)).toEqual(
      [...body.observed.map((row: { domain: string }) => row.domain)].sort((a, b) => a.localeCompare(b)),
    )
    expect(body.otherSources.map((row: { domain: string }) => row.domain)).toEqual(
      [...body.otherSources.map((row: { domain: string }) => row.domain)].sort((a, b) => a.localeCompare(b)),
    )
  })

  it('uses each run\'s frozen v2 market membership and supports an explicit all-markets aggregate', async () => {
    const historicalPlan = marketPlan('old-node', 'legacy-rival.example', 'Legacy Rival')
    const activePlan = marketPlan('current-node', 'current-rival.example', 'Current Rival')
    activePlan.groups.push({
      stableKey: 'southern',
      label: 'Southern',
      targetKeys: ['market-target'],
      competitors: [],
    })
    seedVersion('plan_v1', 1, historicalPlan)
    seedVersion('plan_v2', 2, activePlan)
    db.insert(measurementPlans).values({
      projectId: 'project_northwind',
      activeVersionId: 'plan_v2',
      createdAt: NOW,
      updatedAt: NOW,
    }).run()
    db.insert(runs).values([
      {
        id: 'market_old_run',
        projectId: 'project_northwind',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        measurementPlanVersionId: 'plan_v1',
        location: null,
        createdAt: '2026-08-10T12:00:00.000Z',
      },
      {
        id: 'market_current_run',
        projectId: 'project_northwind',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        measurementPlanVersionId: 'plan_v2',
        location: null,
        createdAt: NOW,
      },
    ]).run()
    db.insert(querySnapshots).values([
      marketSnapshot('market_old_snapshot', 'market_old_run', 'old-node', 'Northwind and Legacy Rival are alternatives.', 'legacy-rival.example'),
      marketSnapshot('market_current_snapshot', 'market_current_run', 'current-node', 'Northwind and Current Rival are alternatives.', 'current-rival.example'),
      marketSnapshot('market_out_of_scope', 'market_current_run', 'not-a-market-node', 'Northwind and Rival are alternatives.', 'rival.example'),
    ]).run()

    const groupResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&groupKey=regional',
    })
    expect(groupResponse.statusCode, groupResponse.body).toBe(200)
    const group = groupResponse.json()
    expect(group).toMatchObject({
      scope: { kind: 'group', groupKey: 'regional' },
      filters: { scope: 'project', groupKey: 'regional' },
      evidence: { answeredResults: 2 },
      marketState: { activeRevision: 2, draft: null },
    })
    expect(group.pinned.map((row: { domain: string }) => row.domain)).toEqual([
      'current-rival.example',
      'rival.example',
    ])
    expect(group.observed).toEqual([expect.objectContaining({
      domain: 'legacy-rival.example',
      surfaceClass: 'direct-competitor',
      mentionCount: 1,
      citationCount: 1,
    })])
    expect(group.otherSources.some((row: { domain: string }) => row.domain === 'legacy-rival.example')).toBe(false)

    // A removed tracked-query row leaves its historic snapshot query_id NULL,
    // but the frozen plan still names its text and class. The market reading
    // must retain that stored answer under its frozen non-brand scope.
    db.insert(querySnapshots).values({
      ...marketSnapshot(
        'market_orphaned_query_snapshot',
        'market_current_run',
        'current-node',
        'Northwind and Current Rival are alternatives.',
        'current-rival.example',
        NOW,
        null,
        'homes near northwind',
      ),
      provider: 'gemini',
    }).run()
    const nonBrandResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&groupKey=regional&queryClass=non-brand',
    })
    expect(nonBrandResponse.statusCode, nonBrandResponse.body).toBe(200)
    expect(nonBrandResponse.json()).toMatchObject({
      scope: { kind: 'group', groupKey: 'regional' },
      evidence: { answeredResults: 3 },
    })

    const pinned = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'pin-legacy-rival' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'regional',
        domain: 'legacy-rival.example',
        label: 'Legacy Rival',
      },
    })
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(pinned.json()).toMatchObject({
      draftCreated: true,
      groupKey: 'regional',
      competitor: { domain: 'legacy-rival.example', label: 'Legacy Rival' },
      published: { revision: 2, competitorsChanged: false },
    })
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'pin-legacy-rival' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'regional',
        domain: 'legacy-rival.example',
        label: 'Legacy Rival',
      },
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(pinned.json())
    expect(db.select().from(measurementPlanDrafts)
      .where(eq(measurementPlanDrafts.projectId, 'project_northwind')).all()).toHaveLength(1)
    const activeFrozen = JSON.parse(db.select().from(measurementPlanVersions)
      .where(eq(measurementPlanVersions.id, 'plan_v2')).get()!.canonicalJson) as { groups: Array<{ competitors: Array<{ domain: string }> }> }
    expect(activeFrozen.groups[0]!.competitors.map(competitor => competitor.domain)).toEqual(['current-rival.example'])

    const rescanned = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&groupKey=regional',
    })
    expect(rescanned.statusCode, rescanned.body).toBe(200)
    expect(rescanned.json()).toMatchObject({
      marketState: {
        activeRevision: 2,
        draft: { pendingCompetitorDomains: ['legacy-rival.example'] },
      },
    })
    expect(rescanned.json().pinned.map((row: { domain: string }) => row.domain)).toEqual([
      'legacy-rival.example',
      'current-rival.example',
      'rival.example',
    ])
    expect(rescanned.json().pinned.find((row: { domain: string }) => row.domain === 'legacy-rival.example'))
      .toMatchObject({ mentionCount: 1, citationCount: 1 })

    const allMarketsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&scope=all-markets&queryClass=non-brand',
    })
    expect(allMarketsResponse.statusCode, allMarketsResponse.body).toBe(200)
    expect(allMarketsResponse.json()).toMatchObject({
      scope: { kind: 'all-markets' },
      filters: { scope: 'all-markets', groupKey: null, queryClass: 'non-brand' },
      evidence: { answeredResults: 3 },
    })

    // A domain can be published in one market while still pending in another.
    // All-markets must compare draft membership per group, not against the
    // union of published competitors across every group.
    const crossMarketPin = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'pin-current-rival-southern' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'southern',
        domain: 'current-rival.example',
      },
    })
    expect(crossMarketPin.statusCode, crossMarketPin.body).toBe(200)
    const allMarketsWithCrossMarketDraft = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/northwind/analytics/competitors?window=all&scope=all-markets',
    })
    expect(allMarketsWithCrossMarketDraft.statusCode, allMarketsWithCrossMarketDraft.body).toBe(200)
    expect(allMarketsWithCrossMarketDraft.json().marketState.draft.pendingCompetitorDomains)
      .toEqual(['legacy-rival.example', 'current-rival.example'])

    const longDomain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(40)}.example`
    const longDomainPin = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'pin-long-valid-domain' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'regional',
        domain: longDomain,
      },
    })
    expect(longDomainPin.statusCode, longDomainPin.body).toBe(200)
    expect(longDomainPin.json().competitor).toMatchObject({ domain: longDomain })
    expect(longDomainPin.json().competitor.stableKey).toHaveLength(128)

    const removedGroup = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/remove-group',
      headers: { 'if-match': longDomainPin.json().etag, 'idempotency-key': 'remove-regional-group' },
      payload: { groupKey: 'regional' },
    })
    expect(removedGroup.statusCode, removedGroup.body).toBe(200)
    const missingGroupDraft = db.select().from(measurementPlanDrafts).get()!
    const rejectedPin = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/northwind/measurement-plan/draft/actions/pin-competitor',
      headers: { 'idempotency-key': 'do-not-restore-regional-group' },
      payload: {
        expectedActiveRevision: 2,
        groupKey: 'regional',
        domain: 'should-not-recreate.example',
      },
    })
    expect(rejectedPin.statusCode, rejectedPin.body).toBe(400)
    expect(db.select().from(measurementPlanDrafts).get()).toEqual(missingGroupDraft)
  })
})

function seedVersion(id: string, revision: number, plan: ReturnType<typeof marketPlan>) {
  db.insert(measurementPlanVersions).values({
    id,
    projectId: 'project_northwind',
    revision,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: `${String(revision).repeat(64)}`,
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
}

function marketPlan(nodeKey: string, competitorDomain: string, competitorLabel: string) {
  return measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: {
      projectBrand: { canonicalHost: 'northwind.example', ownedHosts: ['northwind.example'], names: ['Northwind'] },
    },
    targets: [{
      stableKey: 'market-target',
      label: 'Market Target',
      aliases: ['Northwind'],
      urlMatchers: [{ kind: 'host', host: 'northwind.example' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    }],
    groups: [{
      stableKey: 'regional',
      label: 'Regional',
      targetKeys: ['market-target'],
      competitors: [{ stableKey: competitorDomain.replace('.', '-'), label: competitorLabel, domain: competitorDomain, aliases: [competitorLabel] }],
    }],
    querySnapshots: [{
      queryId: 'market-query',
      queryText: 'homes near northwind',
      provenance: { source: 'manual', sourceId: null, capturedAt: NOW },
    }],
    assignments: [{ targetKey: 'market-target', queryId: 'market-query', queryClass: 'non-brand', executionNodeKey: nodeKey }],
    executionNodes: [{
      stableKey: nodeKey,
      queryId: 'market-query',
      queryText: 'homes near northwind',
      context: { providers: ['openai'], models: {}, location: null },
      expectedSnapshots: 1,
    }],
    usageEdges: [{ executionNodeKey: nodeKey, targetKey: 'market-target', queryId: 'market-query' }],
    compiledChecksum: 'a'.repeat(64),
  })
}

function marketSnapshot(
  id: string,
  runId: string,
  measurementExecutionId: string | null,
  answerText: string,
  citedDomain: string,
  createdAt = NOW,
  queryId: string | null = 'market-query',
  queryText = 'homes near northwind',
) {
  return {
    id,
    runId,
    queryId,
    queryText,
    provider: 'openai',
    citationState: 'not-cited' as const,
    answerMentioned: true,
    answerText,
    citedDomains: [citedDomain],
    citedUrls: null,
    captureStatus: 'complete' as const,
    competitorOverlap: [],
    location: null,
    measurementExecutionId,
    createdAt,
  }
}
