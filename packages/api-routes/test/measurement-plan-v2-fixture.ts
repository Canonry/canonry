/**
 * One published schema-v2 revision, shared by the adapter and overview suites.
 *
 * `exec-nearby` is deliberately reused by both Properties: it is the fixture
 * that proves reuse adds usage edges rather than expected slots. `exec-brand`
 * is the Branded basket, so a class filter has something to exclude.
 */

import crypto from 'node:crypto'
import {
  canonicalMeasurementPlanV2Json,
  measurementPlanV2Schema,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type CitationState,
  type MeasurementPlanV2,
  type RunStatus,
} from '@canonry/canonry-contracts'
import { measurementPlans, measurementPlanVersions, querySnapshots, runs, type DatabaseClient } from '@canonry/canonry-db'
import { buildMeasurementPlanV2Manifest } from '../src/measurement-report-adapter.js'

export const HARBOR_CONTEXT = { label: 'Harbor', city: 'Harbor', region: 'EX', country: 'US' } as const

export function measurementPlanV2Fixture(overrides: Partial<MeasurementPlanV2> = {}): MeasurementPlanV2 {
  return measurementPlanV2Schema.parse({
    schemaVersion: 2,
    identities: {
      projectBrand: {
        canonicalHost: 'northstar.example',
        ownedHosts: ['northstar.example'],
        names: ['Northstar'],
      },
    },
    targets: [
      {
        stableKey: 'harbor',
        label: 'Harbor Homes',
        aliases: ['Harbor Homes'],
        urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor', pathCase: 'insensitive' }],
        mentionNotApplicable: false,
        discoveryIdentity: null,
      },
      {
        stableKey: 'bayside',
        label: 'Bayside Homes',
        aliases: ['Bayside Homes'],
        urlMatchers: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/bayside', pathCase: 'insensitive' }],
        mentionNotApplicable: false,
        discoveryIdentity: null,
      },
    ],
    groups: [
      {
        stableKey: 'regional',
        label: 'Regional comparison',
        targetKeys: ['harbor', 'bayside'],
        competitors: [
          { stableKey: 'challenger', label: 'Challenger', domain: 'challenger.example', aliases: ['Challenger'] },
        ],
      },
    ],
    querySnapshots: [
      {
        queryId: 'q-nearby',
        queryText: 'homes near harbor',
        provenance: { source: 'manual', sourceId: null, capturedAt: '2026-07-01T00:00:00.000Z' },
      },
      {
        queryId: 'q-brand',
        queryText: 'northstar reviews',
        provenance: { source: 'manual', sourceId: null, capturedAt: '2026-07-01T00:00:00.000Z' },
      },
    ],
    assignments: [
      { targetKey: 'harbor', queryId: 'q-nearby', queryClass: 'non-brand', executionNodeKey: 'exec-nearby' },
      { targetKey: 'bayside', queryId: 'q-nearby', queryClass: 'non-brand', executionNodeKey: 'exec-nearby' },
      { targetKey: 'harbor', queryId: 'q-brand', queryClass: 'branded', executionNodeKey: 'exec-brand' },
    ],
    executionNodes: [
      {
        stableKey: 'exec-nearby',
        queryId: 'q-nearby',
        queryText: 'homes near harbor',
        context: { providers: ['openai', 'gemini'], models: {}, location: HARBOR_CONTEXT },
        expectedSnapshots: 2,
      },
      {
        stableKey: 'exec-brand',
        queryId: 'q-brand',
        queryText: 'northstar reviews',
        context: { providers: ['openai', 'gemini'], models: {}, location: HARBOR_CONTEXT },
        expectedSnapshots: 2,
      },
    ],
    usageEdges: [
      { executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' },
      { executionNodeKey: 'exec-nearby', targetKey: 'bayside', queryId: 'q-nearby' },
      { executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-brand' },
    ],
    compiledChecksum: 'b'.repeat(64),
    ...overrides,
  })
}

/** Publishes the plan as the project's active revision 1 and returns its version id. */
export function publishPlanV2(db: DatabaseClient, projectId: string, plan: MeasurementPlanV2, createdAt: string): string {
  const versionId = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id: versionId,
    projectId,
    revision: 1,
    canonicalJson: canonicalMeasurementPlanV2Json(plan),
    checksum: 'c'.repeat(64),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    createdAt,
  }).run()
  db.insert(measurementPlans).values({ projectId, activeVersionId: versionId, createdAt, updatedAt: createdAt }).run()
  return versionId
}

/** What one engine answered for one expected slot. */
export interface PlanV2Answer {
  /** Null stores an answer whose text was not kept, so its mention is unknown. */
  answerText: string | null
  citedUrls?: string[]
  /** `partial` stores a source capture that missed sources, so its citation is unknown. */
  captureStatus?: 'complete' | 'partial'
  /** The project-level column; by default `cited` exactly when a URL was cited. */
  citationState?: CitationState
  /** The project-level column, which a Property never reads. */
  answerMentioned?: boolean
}

/** One whole-plan sweep of the published revision: one stored answer per expected slot, all at `HARBOR_CONTEXT`. */
export function seedPlanV2Sweep(db: DatabaseClient, input: {
  projectId: string
  runId: string
  versionId: string
  plan: MeasurementPlanV2
  createdAt: string
  status?: RunStatus
  /** The model series checksum; a different one is a different series. */
  models?: string
  /** Store each answer under its tracked query's id; the project must hold those `queries` rows. */
  withQueryIds?: boolean
  answer: (slot: { executionId: string; provider: string }) => PlanV2Answer
}): void {
  const manifest = buildMeasurementPlanV2Manifest(input.plan)
  const queryIdByExecution = new Map(input.plan.executionNodes.map(node => [node.stableKey, node.queryId]))
  db.insert(runs).values({
    id: input.runId,
    projectId: input.projectId,
    kind: RunKinds['answer-visibility'],
    status: input.status ?? RunStatuses.completed,
    trigger: RunTriggers.manual,
    measurementPlanVersionId: input.versionId,
    measurementManifest: { schemaVersion: 1, expectedSlots: manifest.expectedSlots },
    measurementExecutionIdentity: {
      schemaVersion: 1,
      providers: ['gemini', 'openai'],
      models: { gemini: 'pin-gemini', openai: 'pin-openai' },
      checksum: input.models ?? 'stable-model-series',
    },
    createdAt: input.createdAt,
    finishedAt: input.createdAt,
  }).run()
  for (const slot of manifest.expectedSlots) {
    const answer = input.answer({ executionId: slot.executionId, provider: slot.provider })
    const citedUrls = answer.citedUrls ?? []
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(),
      runId: input.runId,
      queryId: input.withQueryIds ? queryIdByExecution.get(slot.executionId) ?? null : null,
      queryText: slot.queryText,
      provider: slot.provider,
      servedModel: `${slot.provider}-served`,
      citationState: answer.citationState ?? (citedUrls.length > 0 ? 'cited' : 'not-cited'),
      answerMentioned: answer.answerMentioned ?? true,
      answerText: answer.answerText,
      citedDomains: [],
      citedUrls,
      captureStatus: answer.captureStatus ?? 'complete',
      recommendedCompetitors: [],
      location: HARBOR_CONTEXT.label,
      measurementExecutionId: slot.executionId,
      requestedContext: HARBOR_CONTEXT,
      supportedContext: { status: 'applied', resolved: HARBOR_CONTEXT },
      createdAt: input.createdAt,
    }).run()
  }
}
