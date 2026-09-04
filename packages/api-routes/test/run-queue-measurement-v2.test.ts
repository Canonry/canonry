import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2ChecksumJson,
  parseMeasurementRunManifestV1,
  parseStoredMeasurementExecutionIdentity,
  type LocationContext,
  type MeasurementPlanV2,
  type MeasurementV2ExecutionNode,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlans,
  measurementPlanVersions,
  migrate,
  projects,
  queries,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { assertMeasurementRunStampable, queueRunIfProjectIdle } from '../src/run-queue.js'

const NOW = '2026-08-01T00:00:00.000Z'
const NORTH: LocationContext = { label: 'north-city', city: 'North City', region: 'NC', country: 'US' }
const SOUTH: LocationContext = { label: 'south-city', city: 'South City', region: 'SC', country: 'US' }
const PLACEHOLDER_CHECKSUM = '0'.repeat(64)

interface NodeSpec {
  key: string
  queryId: string
  queryText: string
  providers: string[]
  models?: Record<string, string>
  location: LocationContext | null
}

interface PlanSpec {
  targets: string[]
  groups?: Array<{ key: string; targetKeys: string[] }>
  nodes: NodeSpec[]
  /** Target → the execution node that answers for it. One node may serve many. */
  assignments: Array<{ targetKey: string; nodeKey: string }>
}

function executionNode(spec: NodeSpec): MeasurementV2ExecutionNode {
  return {
    stableKey: spec.key,
    queryId: spec.queryId,
    queryText: spec.queryText,
    context: { providers: spec.providers, models: spec.models ?? {}, location: spec.location },
    expectedSnapshots: spec.providers.length,
  }
}

/** A published v2 revision, checksummed exactly the way the publish path will. */
function v2Plan(spec: PlanSpec): MeasurementPlanV2 {
  const nodesByKey = new Map(spec.nodes.map(node => [node.key, node]))
  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: {
      projectBrand: { canonicalHost: 'example.com', ownedHosts: ['example.com'], names: ['Planned Co'] },
    },
    targets: spec.targets.map(key => ({
      stableKey: key,
      label: key,
      aliases: [key],
      urlMatchers: [{ kind: 'prefix', host: 'example.com', pathPrefix: `/${key}`, pathCase: 'insensitive' }],
      mentionNotApplicable: false,
      discoveryIdentity: null,
    })),
    groups: (spec.groups ?? []).map(group => ({
      stableKey: group.key,
      label: group.key,
      targetKeys: group.targetKeys,
      competitors: [],
    })),
    querySnapshots: [...new Map(spec.nodes.map(node => [node.queryId, {
      queryId: node.queryId,
      queryText: node.queryText,
      provenance: { source: 'manual' as const, sourceId: null, capturedAt: NOW },
    }])).values()],
    assignments: spec.assignments.map(assignment => ({
      targetKey: assignment.targetKey,
      queryId: nodesByKey.get(assignment.nodeKey)!.queryId,
      queryClass: 'non-brand',
      executionNodeKey: assignment.nodeKey,
    })),
    executionNodes: spec.nodes.map(executionNode),
    usageEdges: spec.assignments.map(assignment => ({
      executionNodeKey: assignment.nodeKey,
      targetKey: assignment.targetKey,
      queryId: nodesByKey.get(assignment.nodeKey)!.queryId,
    })),
    compiledChecksum: PLACEHOLDER_CHECKSUM,
  }
  const compiledChecksum = crypto.createHash('sha256').update(measurementPlanV2ChecksumJson(draft)).digest('hex')
  return { ...draft, compiledChecksum }
}

function publishV2(db: DatabaseClient, projectId: string, plan: MeasurementPlanV2, revision: number): string {
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision,
    canonicalJson,
    checksum: crypto.createHash('sha256').update(canonicalJson).digest('hex'),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt: NOW,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt: NOW, updatedAt: NOW })
    .onConflictDoUpdate({
      target: measurementPlans.projectId,
      set: { activeVersionId: versionId, updatedAt: NOW },
    })
    .run()
  return versionId
}

function seed(options: { queryIds?: string[]; projectProviders?: string[] } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-run-queue-v2-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'planned',
    displayName: 'Planned Co',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: options.projectProviders ?? [],
    locations: [NORTH, SOUTH],
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  for (const [index, queryId] of (options.queryIds ?? ['q-1']).entries()) {
    db.insert(queries).values({ id: queryId, projectId, query: `widget question ${index}`, createdAt: NOW }).run()
  }
  return { db, projectId }
}

function queuedRun(db: DatabaseClient, runId: string) {
  return db.select().from(runs).where(eq(runs.id, runId)).get()!
}

function queue(db: DatabaseClient, projectId: string, params: Parameters<typeof queueRunIfProjectIdle>[1] | Record<string, unknown> = {}) {
  const result = queueRunIfProjectIdle(db, { projectId, ...params } as Parameters<typeof queueRunIfProjectIdle>[1])
  if (result.conflict) throw new Error('unexpected conflict')
  return result.runId
}

describe('a published v2 revision at queue time', () => {
  it('materializes the manifest from the revision\'s own execution nodes and frozen engines', () => {
    // The project row names an engine the revision does not run. A v2 revision
    // freezes provider configuration, so the plan wins.
    const { db, projectId } = seed({ projectProviders: ['gemini'] })
    publishV2(db, projectId, v2Plan({
      targets: ['north-branch', 'south-branch'],
      nodes: [
        { key: 'exec-north', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], models: { openai: 'gpt-planned' }, location: NORTH },
        { key: 'exec-south', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], models: { openai: 'gpt-planned' }, location: SOUTH },
      ],
      assignments: [
        { targetKey: 'north-branch', nodeKey: 'exec-north' },
        { targetKey: 'south-branch', nodeKey: 'exec-south' },
      ],
    }), 1)

    const row = queuedRun(db, queue(db, projectId))
    const manifest = parseMeasurementRunManifestV1(row.measurementManifest)

    expect(manifest.expectedSlots).toHaveLength(2)
    expect(manifest.expectedSlots.map(slot => slot.provider)).toEqual(['openai', 'openai'])
    expect(manifest.expectedSlots.map(slot => slot.executionId).sort()).toEqual(['exec-north', 'exec-south'])
    expect(manifest.expectedSlots.map(slot => slot.context?.label).sort()).toEqual(['north-city', 'south-city'])
    // Requested model identity: what the revision froze, not what the instance
    // happens to point the engine at today.
    expect(manifest.expectedSlots.every(slot => slot.requestedModel === 'gpt-planned')).toBe(true)
  })

  it('pins the version that was active at queue time and records the frozen execution identity', () => {
    const { db, projectId } = seed()
    const firstVersionId = publishV2(db, projectId, v2Plan({
      targets: ['north-branch'],
      nodes: [{ key: 'exec-north', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], models: { openai: 'gpt-planned' }, location: NORTH }],
      assignments: [{ targetKey: 'north-branch', nodeKey: 'exec-north' }],
    }), 1)

    const runId = queue(db, projectId)

    // A later revision must never rewrite what an already-queued run measures.
    publishV2(db, projectId, v2Plan({
      targets: ['north-branch'],
      nodes: [{ key: 'exec-later', queryId: 'q-1', queryText: 'widget question 0', providers: ['gemini'], location: SOUTH }],
      assignments: [{ targetKey: 'north-branch', nodeKey: 'exec-later' }],
    }), 2)

    const row = queuedRun(db, runId)
    expect(row.measurementPlanVersionId).toBe(firstVersionId)
    expect(parseMeasurementRunManifestV1(row.measurementManifest).expectedSlots.map(slot => slot.executionId))
      .toEqual(['exec-north'])

    const identity = parseStoredMeasurementExecutionIdentity(row.measurementExecutionIdentity)
    expect(identity.providers).toEqual(['openai'])
    expect(identity.models).toEqual({ openai: 'gpt-planned' })
  })

  it('runs one provider request per execution node however many Properties reuse it', () => {
    // The reuse case the model exists for: one question, one context, one
    // engine, shared by every Property in a portfolio.
    const { db, projectId } = seed()
    const targets = Array.from({ length: 194 }, (_, index) => `property-${String(index + 1).padStart(3, '0')}`)
    publishV2(db, projectId, v2Plan({
      targets,
      nodes: [{ key: 'exec-shared', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai', 'gemini'], location: NORTH }],
      assignments: targets.map(targetKey => ({ targetKey, nodeKey: 'exec-shared' })),
    }), 1)

    const manifest = parseMeasurementRunManifestV1(queuedRun(db, queue(db, projectId)).measurementManifest)

    expect(manifest.expectedSlots).toHaveLength(2)
    expect(manifest.expectedSlots.map(slot => slot.provider)).toEqual(['gemini', 'openai'])
  })

  it('collapses two nodes that describe the same question, place and engine configuration', () => {
    // A duplicate node buys a second provider call and inflates the
    // denominator every rate in the revision is taken over.
    const { db, projectId } = seed()
    publishV2(db, projectId, v2Plan({
      targets: ['north-branch', 'south-branch'],
      nodes: [
        { key: 'exec-a', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], models: { openai: 'gpt-planned' }, location: NORTH },
        { key: 'exec-b', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], models: { openai: 'gpt-planned' }, location: NORTH },
      ],
      assignments: [
        { targetKey: 'north-branch', nodeKey: 'exec-a' },
        { targetKey: 'south-branch', nodeKey: 'exec-b' },
      ],
    }), 1)

    const manifest = parseMeasurementRunManifestV1(queuedRun(db, queue(db, projectId)).measurementManifest)

    expect(manifest.expectedSlots).toHaveLength(1)
    expect(manifest.expectedSlots[0]!.executionId).toBe('exec-a')
  })

  it('records the instance model pointer when the revision froze none', () => {
    const { db, projectId } = seed()
    publishV2(db, projectId, v2Plan({
      targets: ['north-branch'],
      nodes: [{ key: 'exec-north', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], location: NORTH }],
      assignments: [{ targetKey: 'north-branch', nodeKey: 'exec-north' }],
    }), 1)

    const row = queuedRun(db, queue(db, projectId, {
      providerModels: { openai: 'gpt-instance' },
      providerRouteDescriptors: {
        openai: { routeId: 'native:openai', routeRevision: 1, policyFingerprint: 'a'.repeat(64) },
      },
    }))

    expect(parseMeasurementRunManifestV1(row.measurementManifest).expectedSlots[0]!.requestedModel).toBe('gpt-instance')
    const identity = parseStoredMeasurementExecutionIdentity(row.measurementExecutionIdentity)
    expect(identity.models).toEqual({ openai: 'gpt-instance' })
    expect(identity).toMatchObject({
      schemaVersion: 2,
      routes: {
        openai: {
          routeId: 'native:openai', routeRevision: 1, policyFingerprint: 'a'.repeat(64),
          requestedProvider: 'openai', requestedModel: 'gpt-instance',
        },
      },
    })
  })

  it('keeps already queued route revision and policy immutable when the host route changes', () => {
    const { db, projectId } = seed()
    publishV2(db, projectId, v2Plan({
      targets: ['north-branch'],
      nodes: [{ key: 'exec-north', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], models: { openai: 'gpt-planned' }, location: NORTH }],
      assignments: [{ targetKey: 'north-branch', nodeKey: 'exec-north' }],
    }), 1)
    const firstId = queue(db, projectId, {
      providerRouteDescriptors: {
        openai: { routeId: 'native:openai', routeRevision: 1, policyFingerprint: '1'.repeat(64) },
      },
    })
    db.update(runs).set({ status: 'completed' }).where(eq(runs.id, firstId)).run()
    const secondId = queue(db, projectId, {
      providerRouteDescriptors: {
        openai: { routeId: 'native:openai', routeRevision: 2, policyFingerprint: '2'.repeat(64) },
      },
    })

    const first = parseStoredMeasurementExecutionIdentity(queuedRun(db, firstId).measurementExecutionIdentity)
    const second = parseStoredMeasurementExecutionIdentity(queuedRun(db, secondId).measurementExecutionIdentity)
    expect(first).toMatchObject({ schemaVersion: 2, routes: { openai: { routeRevision: 1, policyFingerprint: '1'.repeat(64) } } })
    expect(second).toMatchObject({ schemaVersion: 2, routes: { openai: { routeRevision: 2, policyFingerprint: '2'.repeat(64) } } })
  })

  it('refuses a run that asks for engines the revision was not published with', () => {
    const { db, projectId } = seed()
    publishV2(db, projectId, v2Plan({
      targets: ['north-branch'],
      nodes: [{ key: 'exec-north', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], location: NORTH }],
      assignments: [{ targetKey: 'north-branch', nodeKey: 'exec-north' }],
    }), 1)

    expect(() => queueRunIfProjectIdle(db, { projectId, providers: ['gemini'] }))
      .toThrow(/openai/)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })
})

describe('a slice of a published v2 revision', () => {
  function seedSliceable() {
    const { db, projectId } = seed({ queryIds: ['q-1', 'q-2'] })
    publishV2(db, projectId, v2Plan({
      targets: ['north-branch', 'south-branch'],
      groups: [{ key: 'metro-group', targetKeys: ['south-branch'] }],
      nodes: [
        { key: 'exec-north', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], location: NORTH },
        { key: 'exec-south', queryId: 'q-2', queryText: 'widget question 1', providers: ['openai'], location: SOUTH },
      ],
      assignments: [
        { targetKey: 'north-branch', nodeKey: 'exec-north' },
        { targetKey: 'south-branch', nodeKey: 'exec-south' },
      ],
    }), 1)
    return { db, projectId }
  }

  it('narrows to the group members, records the scope and keeps the run a probe', () => {
    const { db, projectId } = seedSliceable()

    const row = queuedRun(db, queue(db, projectId, { measurementScope: { groups: ['metro-group'] } }))

    expect(row.measurementScope).toEqual({ groups: ['metro-group'], targets: [], queries: [], resolvedTargets: ['south-branch'] })
    expect(row.trigger).toBe('probe')
    // A spot check measures a subset, so labelling it with the full basket
    // would let it read as though the whole set had been measured.
    expect(row.queryBasketRevision).toBeNull()
    expect(parseMeasurementRunManifestV1(row.measurementManifest).expectedSlots.map(slot => slot.executionId))
      .toEqual(['exec-south'])
  })

  it('names back a group the pinned revision does not contain', () => {
    const { db, projectId } = seedSliceable()

    expect(() => queueRunIfProjectIdle(db, { projectId, measurementScope: { groups: ['west-region'] } }))
      .toThrow(/"west-region"/)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })

  it('measures only the questions a query list names', () => {
    const { db, projectId } = seedSliceable()

    const row = queuedRun(db, queue(db, projectId, { queries: ['widget question 1'] }))

    expect(row.measurementScope).toEqual({ groups: [], targets: [], queries: ['widget question 1'], resolvedTargets: [] })
    expect(parseMeasurementRunManifestV1(row.measurementManifest).expectedSlots.map(slot => slot.executionId))
      .toEqual(['exec-south'])
  })

  it('names back a question the pinned revision does not measure', () => {
    const { db, projectId } = seedSliceable()

    expect(() => queueRunIfProjectIdle(db, { projectId, queries: ['widget question 9'] }))
      .toThrow(/"widget question 9"/)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })
})

describe('no active revision', () => {
  it('refuses a target-scoped run rather than sweeping everything', () => {
    const { db, projectId } = seed()

    expect(() => queueRunIfProjectIdle(db, { projectId, measurementScope: { targets: ['north-branch'] } }))
      .toThrow(/no published measurement plan/i)
    expect(db.select().from(runs).all()).toHaveLength(0)
  })
})

describe('the preflight check', () => {
  it('validates a v2 revision without queueing any work', () => {
    // Publishing and reviewing must never start a run: the preflight the batch
    // trigger uses runs the same checks and writes nothing.
    const { db, projectId } = seed()
    publishV2(db, projectId, v2Plan({
      targets: ['north-branch'],
      nodes: [{ key: 'exec-north', queryId: 'q-1', queryText: 'widget question 0', providers: ['openai'], location: NORTH }],
      assignments: [{ targetKey: 'north-branch', nodeKey: 'exec-north' }],
    }), 1)

    assertMeasurementRunStampable(db, { projectId })

    expect(db.select().from(runs).all()).toHaveLength(0)
  })
})
