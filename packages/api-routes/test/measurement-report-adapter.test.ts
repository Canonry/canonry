import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalMeasurementPlanJson,
  canonicalMeasurementPlanV2Json,
  compileMeasurementPlan,
  type MeasurementPlan,
  type MeasurementPlanV2,
} from '@ainyc/canonry-contracts'
import {
  createClient,
  measurementPlanVersions,
  migrate,
  projects,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  buildMeasurementPlanV2Manifest,
  buildMeasurementPlanV2ReportInput,
  buildMeasurementRunManifest,
  buildStoredMeasurementReport,
} from '../src/measurement-report-adapter.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

let directory: string
let db: DatabaseClient
let projectId: string
let plan: MeasurementPlan

function now(): string {
  return '2026-08-01T12:00:00.000Z'
}

function beforePlan(): string {
  return '2026-07-31T12:00:00.000Z'
}

function seedPlan(): MeasurementPlan {
  return compileMeasurementPlan({
    schemaVersion: 1,
    targets: [{
      stableKey: 'harbor',
      label: 'Harbor Homes',
      urls: [{ kind: 'prefix', host: 'northstar.example', pathPrefix: '/locations/harbor', pathCase: 'insensitive' }],
      aliases: ['Harbor Homes'],
    }],
    groups: [{
      stableKey: 'regional',
      label: 'Regional comparison',
      targetKeys: ['harbor'],
      competitors: ['challenger.example'],
    }],
    targetQuerySelections: [{ targetKey: 'harbor', queryIds: ['q-nearby'] }],
  }, {
    canonicalDomain: 'northstar.example',
    ownedDomains: ['homes.northstar.example'],
    brandNames: ['Northstar'],
    trackedQueries: [{ id: 'q-nearby', query: 'homes near harbor' }],
    locations: [{ label: 'Harbor', city: 'Harbor', region: 'EX', country: 'US' }],
    defaultContext: { label: 'Harbor', city: 'Harbor', region: 'EX', country: 'US' },
    expectedSnapshots: 2,
  })
}

function seedVersion(value = plan, revision = 7): string {
  const id = crypto.randomUUID()
  db.insert(measurementPlanVersions).values({
    id,
    projectId,
    revision,
    canonicalJson: canonicalMeasurementPlanJson(value),
    checksum: 'a'.repeat(64),
    createdAt: now(),
  }).run()
  return id
}

function seedRun(versionId: string, manifest = buildMeasurementRunManifest(plan, ['openai', 'gemini'])): string {
  const id = crypto.randomUUID()
  db.insert(runs).values({
    id,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    measurementPlanVersionId: versionId,
    measurementManifest: manifest,
    createdAt: now(),
  }).run()
  return id
}

function seedSnapshot(runId: string, values: Partial<typeof querySnapshots.$inferInsert>): string {
  const id = crypto.randomUUID()
  db.insert(querySnapshots).values({
    id,
    runId,
    queryId: null,
    queryText: 'homes near harbor',
    provider: 'openai',
    citationState: 'cited',
    answerMentioned: true,
    answerText: 'Northstar recommends Harbor Homes.',
    citedDomains: [],
    competitorOverlap: [],
    recommendedCompetitors: [],
    supportedContext: { status: 'applied', resolved: plan.executionNodes[0]?.context ?? null },
    createdAt: now(),
    ...values,
  }).run()
  return id
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-measurement-adapter-'))
  db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'northstar',
    displayName: 'Northstar',
    canonicalDomain: 'current.example',
    ownedDomains: ['current-owned.example'],
    country: 'US',
    language: 'en',
    locations: [],
    providers: [],
    createdAt: now(),
    updatedAt: now(),
  }).run()
  plan = seedPlan()
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('measurement report adapter', () => {
  it('materializes one deterministic execution id across providers and rejects an incomplete roster', () => {
    const manifest = buildMeasurementRunManifest(plan, ['openai', 'gemini'])
    expect(manifest.expectedSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({ executionId: plan.executionNodes[0]?.stableKey, provider: 'openai' }),
      expect.objectContaining({ executionId: plan.executionNodes[0]?.stableKey, provider: 'gemini' }),
    ]))
    expect(() => buildMeasurementRunManifest(plan, ['openai'])).toThrow('does not satisfy')
  })

  it('reconstructs a pinned plan report from direct snapshots only', () => {
    const versionId = seedVersion()
    const manifest = buildMeasurementRunManifest(plan, ['openai', 'gemini'])
    const runId = seedRun(versionId, manifest)
    const openai = manifest.expectedSlots.find(slot => slot.provider === 'openai')!

    seedSnapshot(runId, {
      measurementExecutionId: openai.executionId,
      requestedContext: openai.context,
      location: 'Harbor',
      citedUrls: ['https://northstar.example/locations/harbor/details'],
      captureStatus: 'complete',
    })
    seedSnapshot(runId, {
      provider: 'gemini',
      measurementExecutionId: openai.executionId,
      requestedContext: openai.context,
      location: 'Harbor',
      citedUrls: ['https://northstar.example/locations/harbor'],
      captureStatus: 'complete',
    })

    const result = buildStoredMeasurementReport(db, projectId, 7)

    expect(result.kind).toBe('report')
    if (result.kind !== 'report') throw new Error('Expected report')
    expect(result.report.run?.id).toBe(runId)
    expect(result.report.revision).toBe(7)
    expect(result.report.targets[0]).toMatchObject({ id: 'harbor', label: 'Harbor Homes' })
    expect(result.report.groups[0]).toMatchObject({ id: 'regional', label: 'Regional comparison', targetIds: ['harbor'] })
    expect(result.report.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', classification: 'assigned', historical: false, evidenceComplete: true }),
      expect.objectContaining({ provider: 'gemini', classification: 'assigned', bridged: false, historical: false, evidenceComplete: true }),
    ]))
    expect(result.report.groups[0]?.answerCoverage).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(result.report.groups[0]?.sov.domains[0]).toEqual({ domain: 'northstar.example', own: true, presentIn: 2, of: 2 })
  })

  it('bridges snapshots from a real completed pre-plan run', () => {
    seedVersion()
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId,
      projectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      measurementPlanVersionId: null,
      measurementManifest: null,
      createdAt: beforePlan(),
    }).run()
    seedSnapshot(runId, {
      provider: 'openai',
      measurementExecutionId: null,
      location: 'Harbor',
      citedUrls: null,
      rawResponse: JSON.stringify({ groundingSources: [{ uri: 'https://northstar.example/locations/harbor' }] }),
    })
    seedSnapshot(runId, {
      provider: 'gemini',
      measurementExecutionId: null,
      location: ' harbor ',
      citedUrls: null,
      rawResponse: JSON.stringify({ groundingSources: [{ uri: 'https://northstar.example/locations/harbor/details' }] }),
    })

    const result = buildStoredMeasurementReport(db, projectId, 7)
    expect(result.kind).toBe('report')
    if (result.kind !== 'report') throw new Error('Expected report')
    expect(result.report.run?.id).toBe(runId)
    expect(result.report.diagnostics.bridgedObservationIds).toHaveLength(2)
    expect(result.report.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', bridged: true, historical: true, classification: 'assigned' }),
      expect.objectContaining({ provider: 'gemini', bridged: true, historical: true, classification: 'assigned' }),
    ]))
  })

  it('withholds historical evidence when stored sources are malformed or need a live redirect', () => {
    seedVersion()
    const runId = crypto.randomUUID()
    db.insert(runs).values({
      id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual',
      measurementPlanVersionId: null, measurementManifest: null, createdAt: beforePlan(),
    }).run()
    const malformedId = seedSnapshot(runId, {
      provider: 'openai', measurementExecutionId: null, location: 'Harbor', citedUrls: null,
      rawResponse: JSON.stringify({ groundingSources: [{ title: 'missing URI' }] }),
    })
    const redirectId = seedSnapshot(runId, {
      provider: 'gemini', measurementExecutionId: null, location: 'Harbor', citedUrls: null,
      rawResponse: JSON.stringify({ groundingSources: [{ uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/pending' }] }),
    })

    const result = buildStoredMeasurementReport(db, projectId, 7)
    expect(result.kind).toBe('report')
    if (result.kind !== 'report') throw new Error('Expected report')
    expect(result.report.evidence).toEqual([])
    expect(result.report.diagnostics.evidenceIncompleteObservationIds).toEqual([redirectId, malformedId].sort())
    expect(result.report.targets[0]?.citationCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' })
  })

  it('reports incomplete population when an expected provider slot has no snapshot', () => {
    const versionId = seedVersion()
    const manifest = buildMeasurementRunManifest(plan, ['openai', 'gemini'])
    const runId = seedRun(versionId, manifest)
    const openai = manifest.expectedSlots.find(slot => slot.provider === 'openai')!
    seedSnapshot(runId, {
      measurementExecutionId: openai.executionId,
      requestedContext: openai.context,
      location: 'Harbor',
      citedUrls: [],
      captureStatus: 'complete',
    })

    const result = buildStoredMeasurementReport(db, projectId, 7)
    expect(result.kind).toBe('report')
    if (result.kind !== 'report') throw new Error('Expected report')
    expect(result.report.targets[0]?.citationCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
  })

  it('does not count a plan-aware snapshot when its requested context was ignored', () => {
    const versionId = seedVersion()
    const manifest = buildMeasurementRunManifest(plan, ['openai', 'gemini'])
    const runId = seedRun(versionId, manifest)
    const openai = manifest.expectedSlots.find(slot => slot.provider === 'openai')!
    seedSnapshot(runId, {
      measurementExecutionId: openai.executionId,
      requestedContext: openai.context,
      supportedContext: { status: 'ignored' },
      // The runner stores no claimed location when a provider ignores the
      // requested context. The frozen requested context still identifies the
      // intended slot, but this observation must remain outside its metrics.
      location: null,
      citedUrls: [],
      captureStatus: 'complete',
    })

    const result = buildStoredMeasurementReport(db, projectId, 7)
    expect(result.kind).toBe('report')
    if (result.kind !== 'report') throw new Error('Expected report')
    expect(result.report.targets[0]?.completeness).toMatchObject({ executed: 0, expected: 2, complete: false })
    expect(result.report.targets[0]?.citationCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'incomplete' })
  })

  it('returns honest no-population envelopes without a plan or eligible run', () => {
    expect(buildStoredMeasurementReport(db, projectId, 7)).toEqual({ kind: 'no-plan', revision: 7 })
    expect(buildStoredMeasurementReport(db, projectId, 99)).toEqual({ kind: 'no-plan', revision: 99 })

    seedVersion()
    const noRun = buildStoredMeasurementReport(db, projectId, 7)
    expect(noRun.kind).toBe('no-population')
    if (noRun.kind !== 'no-population') throw new Error('Expected no population')
    expect(noRun.report).toMatchObject({ revision: 7, run: null })
    expect(noRun.report.targets[0]?.citationCoverage)
      .toEqual({ numerator: null, denominator: null, rate: null, reason: 'no-population' })
  })

  it('reads every answer of a schema v1 revision, which records no class, and refuses a request for one class', () => {
    seedVersion()
    const unclassified = buildStoredMeasurementReport(db, projectId, 7)
    if (unclassified.kind === 'no-plan') throw new Error('Expected a report envelope')
    expect(unclassified.report.queryClass).toBeNull()
    const pooled = buildStoredMeasurementReport(db, projectId, 7, undefined, 'all')
    if (pooled.kind === 'no-plan') throw new Error('Expected a report envelope')
    expect(pooled.report.queryClass).toBeNull()
    for (const queryClass of ['non-brand', 'branded'] as const) {
      expect(() => buildStoredMeasurementReport(db, projectId, 7, undefined, queryClass))
        .toThrow('Revision 7 is a schema v1 plan, which records no query class. Omit queryClass to read every answer.')
    }
  })

  it('selects the requested immutable revision rather than a newer plan or current project identity', () => {
    const versionSeven = seedVersion(plan, 7)
    const runId = seedRun(versionSeven)
    seedVersion(plan, 8)

    const historical = buildStoredMeasurementReport(db, projectId, 7)
    expect(historical.kind).toBe('report')
    if (historical.kind !== 'report') throw new Error('Expected report')
    expect(historical.report.revision).toBe(7)
    expect(historical.report.run?.id).toBe(runId)
    expect(historical.report.groups[0]?.sov.domains[0]?.domain).toBe('northstar.example')
    const noRun = buildStoredMeasurementReport(db, projectId, 8)
    expect(noRun.kind).toBe('no-population')
    if (noRun.kind !== 'no-population') throw new Error('Expected no population')
    expect(noRun.report).toMatchObject({ revision: 8, run: null })
  })

  it('fails loudly when a pinned manifest does not match the immutable plan', () => {
    const versionId = seedVersion()
    const manifest = buildMeasurementRunManifest(plan, ['openai', 'gemini'])
    const runId = seedRun(versionId, {
      ...manifest,
      expectedSlots: manifest.expectedSlots.map(slot => slot.provider === 'openai' ? { ...slot, queryText: 'corrupt query' } : slot),
    })
    seedSnapshot(runId, { measurementExecutionId: manifest.expectedSlots[0]!.executionId, location: 'Harbor', citedUrls: [], captureStatus: 'complete' })

    expect(() => buildStoredMeasurementReport(db, projectId, 7)).toThrow('measurement manifest')
  })

  it('rejects a plan-aware snapshot whose frozen context is absent or different', () => {
    const versionId = seedVersion()
    const manifest = buildMeasurementRunManifest(plan, ['openai', 'gemini'])
    const runId = seedRun(versionId, manifest)
    const openai = manifest.expectedSlots.find(slot => slot.provider === 'openai')!
    seedSnapshot(runId, {
      measurementExecutionId: openai.executionId,
      requestedContext: null,
      location: 'Harbor',
      citedUrls: [],
      captureStatus: 'complete',
    })

    expect(() => buildStoredMeasurementReport(db, projectId, 7)).toThrow('snapshot context is corrupt')
  })

  it('rejects a plan-aware snapshot whose requested model differs from its manifest slot', () => {
    const versionId = seedVersion()
    const manifest = buildMeasurementRunManifest(plan, ['openai', 'gemini'])
    const withModel = {
      ...manifest,
      expectedSlots: manifest.expectedSlots.map(slot => slot.provider === 'openai'
        ? { ...slot, requestedModel: 'model-a' }
        : slot),
    }
    const runId = seedRun(versionId, withModel)
    const openai = withModel.expectedSlots.find(slot => slot.provider === 'openai')!
    seedSnapshot(runId, {
      provider: 'openai',
      model: 'model-b',
      measurementExecutionId: openai.executionId,
      requestedContext: openai.context,
      location: 'Harbor',
      citedUrls: [],
      captureStatus: 'complete',
    })

    expect(() => buildStoredMeasurementReport(db, projectId, 7)).toThrow('requested model is corrupt')
  })
})

describe('measurement report adapter, schema v2', () => {
  let planV2: MeasurementPlanV2

  function seedVersionV2(revision = 11): string {
    const id = crypto.randomUUID()
    db.insert(measurementPlanVersions).values({
      id,
      projectId,
      revision,
      canonicalJson: canonicalMeasurementPlanV2Json(planV2),
      checksum: 'c'.repeat(64),
      schemaVersion: 2,
      compiledChecksum: planV2.compiledChecksum,
      createdAt: now(),
    }).run()
    return id
  }

  function seedRunV2(versionId: string, values: Partial<typeof runs.$inferInsert> = {}): string {
    const id = crypto.randomUUID()
    db.insert(runs).values({
      id,
      projectId,
      kind: 'answer-visibility',
      status: 'completed',
      trigger: 'manual',
      measurementPlanVersionId: versionId,
      measurementManifest: buildMeasurementPlanV2Manifest(planV2),
      createdAt: now(),
      ...values,
    }).run()
    return id
  }

  function seedV2Snapshot(runId: string, executionKey: string, provider: string, values: Partial<typeof querySnapshots.$inferInsert>): string {
    const node = planV2.executionNodes.find(candidate => candidate.stableKey === executionKey)!
    const id = crypto.randomUUID()
    db.insert(querySnapshots).values({
      id,
      runId,
      queryId: null,
      queryText: node.queryText,
      provider,
      citationState: 'cited',
      answerMentioned: true,
      answerText: 'Harbor Homes and Challenger are both worth a look.',
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      measurementExecutionId: executionKey,
      requestedContext: node.context.location,
      supportedContext: { status: 'applied', resolved: node.context.location },
      location: node.context.location?.label ?? null,
      citedUrls: [],
      captureStatus: 'complete',
      createdAt: now(),
      ...values,
    }).run()
    return id
  }

  beforeEach(() => {
    planV2 = measurementPlanV2Fixture()
  })

  it('expands one expected slot per frozen provider on each execution node', () => {
    const manifest = buildMeasurementPlanV2Manifest(planV2)

    expect(manifest.expectedSlots).toHaveLength(4)
    expect(manifest.expectedSlots.filter(slot => slot.executionId === 'exec-nearby').map(slot => slot.provider))
      .toEqual(['gemini', 'openai'])
  })

  it('reuses one execution across Properties without adding an expected slot', () => {
    const manifest = buildMeasurementPlanV2Manifest(planV2)
    const { input, edgeQueryClass } = buildMeasurementPlanV2ReportInput(11, planV2, manifest, [])

    // Two Properties, one shared question: two usage edges over the same two slots.
    expect(input.expectedSlots.filter(slot => slot.executionId === 'exec-nearby')).toHaveLength(2)
    expect(input.usageEdges.filter(edge => edge.executionId === 'exec-nearby')).toHaveLength(2)
    expect([...edgeQueryClass.values()].sort()).toEqual(['branded', 'non-brand', 'non-brand'])
  })

  it('carries the frozen identity, aliases and competitors rather than live project state', () => {
    const { input } = buildMeasurementPlanV2ReportInput(11, planV2, buildMeasurementPlanV2Manifest(planV2), [])

    expect(input.projectDomain).toBe('northstar.example')
    expect(input.projectBrandNames).toEqual(['Northstar'])
    expect(input.groups[0]?.competitors).toEqual([{ domain: 'challenger.example', aliases: ['Challenger'] }])
    expect(input.targets.map(target => target.id).sort()).toEqual(['bayside', 'harbor'])
  })

  it('reports a v2 revision instead of the slice-1 no-plan placeholder', () => {
    const versionId = seedVersionV2()
    const runId = seedRunV2(versionId)
    for (const provider of ['openai', 'gemini']) {
      seedV2Snapshot(runId, 'exec-nearby', provider, {
        citedUrls: ['https://northstar.example/locations/harbor/details'],
      })
      seedV2Snapshot(runId, 'exec-brand', provider, {})
    }

    const result = buildStoredMeasurementReport(db, projectId, 11)

    expect(result.kind).toBe('report')
    if (result.kind !== 'report') throw new Error('Expected report')
    expect(result.report.revision).toBe(11)
    expect(result.report.run?.id).toBe(runId)
    expect(result.report.targets.map(target => target.id)).toEqual(['bayside', 'harbor'])
    expect(result.report.groups[0]).toMatchObject({ id: 'regional', targetIds: ['bayside', 'harbor'] })
  })

  it('reads one query class, non-brand unless another is named, and pools only on request', () => {
    const versionId = seedVersionV2()
    const runId = seedRunV2(versionId)
    // Harbor's page is cited on both non-brand answers; the branded answers
    // cite only a review site.
    for (const provider of ['openai', 'gemini']) {
      seedV2Snapshot(runId, 'exec-nearby', provider, {
        citedUrls: ['https://northstar.example/locations/harbor/details'],
      })
      seedV2Snapshot(runId, 'exec-brand', provider, { citedUrls: ['https://reviews.example/northstar'] })
    }
    const harbor = (queryClass?: 'non-brand' | 'branded' | 'all') => {
      const result = buildStoredMeasurementReport(db, projectId, 11, undefined, queryClass)
      if (result.kind !== 'report') throw new Error('Expected report')
      return {
        queryClass: result.report.queryClass,
        citation: result.report.targets.find(target => target.id === 'harbor')?.citationCoverage,
        evidenceEdges: new Set(result.report.evidence.map(row => row.executionId)),
      }
    }

    expect(harbor()).toEqual({ queryClass: 'non-brand', citation: { numerator: 2, denominator: 2, rate: 1 }, evidenceEdges: new Set(['exec-nearby']) })
    expect(harbor('branded')).toEqual({ queryClass: 'branded', citation: { numerator: 0, denominator: 2, rate: 0 }, evidenceEdges: new Set(['exec-brand']) })
    expect(harbor('all')).toEqual({ queryClass: 'all', citation: { numerator: 2, denominator: 4, rate: 0.5 }, evidenceEdges: new Set(['exec-nearby', 'exec-brand']) })
  })

  it('never displays a scoped spot check as the revision default', () => {
    const versionId = seedVersionV2()
    seedRunV2(versionId, {
      measurementScope: { groups: [], targets: ['harbor'], queries: [], resolvedTargets: ['harbor'] },
    })

    const result = buildStoredMeasurementReport(db, projectId, 11)

    expect(result.kind).toBe('no-population')
  })

  it('reports no population rather than joining a run pinned to another revision', () => {
    const other = seedVersionV2(10)
    seedVersionV2(11)
    seedRunV2(other)

    const result = buildStoredMeasurementReport(db, projectId, 11)

    expect(result.kind).toBe('no-population')
    if (result.kind !== 'no-population') throw new Error('Expected no population')
    expect(result.report).toMatchObject({ revision: 11, run: null })
  })
})
