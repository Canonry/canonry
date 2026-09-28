import { describe, expect, it } from 'vitest'
import type { MeasurementPlanResponse, MeasurementReportResponse } from '@ainyc/canonry-api-client'

import {
  adaptVersionOneMeasurementReport,
  indexVersionOneEvidenceByTarget,
} from '../src/components/project/advanced-measurement/v1-report-adapter.js'

const activePlan = {
  revision: 3,
  checksum: 'synthetic-checksum',
  plan: {
    schemaVersion: 1,
    defaultContext: null,
    effectiveOwnedHosts: ['example.com'],
    projectCanonicalHost: 'example.com',
    projectBrandNames: ['Example'],
    targets: [{
      stableKey: 'harbor-house',
      label: 'Harbor House',
      aliases: ['Harbor House'],
      urls: [{ kind: 'prefix', host: 'example.com', pathPrefix: '/places/harbor', pathCase: 'insensitive' }],
      mentionNotApplicable: false,
    }],
    groups: [{ stableKey: 'waterfront', label: 'Waterfront', targetKeys: ['harbor-house'], competitors: ['rival.example'] }],
    targetQuerySelections: [{ targetKey: 'harbor-house', queryIds: ['query-1'], context: null }],
    querySnapshots: [{ queryId: 'query-1', queryText: 'event venues near the harbor' }],
    executionNodes: [{
      stableKey: 'execution-1',
      queryText: 'event venues near the harbor',
      context: null,
      expectedSnapshots: 1,
    }],
    usageEdges: [],
    warnings: [],
  },
} as unknown as NonNullable<MeasurementPlanResponse['active']>

const report = {
  revision: 3,
  run: {
    id: 'run-1',
    status: 'completed',
    createdAt: '2026-08-02T12:00:00.000Z',
    startedAt: '2026-08-02T12:00:00.000Z',
    finishedAt: '2026-08-02T12:05:00.000Z',
  },
  groups: [],
  targets: [{
    id: 'harbor-house',
    label: 'Harbor House',
    completeness: { executed: 1, expected: 1, sourceCompleteObservations: 1, complete: true, sourceComplete: true, answerComplete: true },
    citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
    mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
    providers: [],
  }],
  evidence: [{
    observationId: 'observation-1',
    expectedSlotId: 'slot-1',
    executionId: 'execution-1',
    usageEdgeId: 'target:harbor-house:query-1:node-1',
    usageEdgeType: 'target',
    provider: 'openai',
    queryText: 'event venues near the harbor',
    location: null,
    sourceUrl: 'https://example.com/places/another',
    bridged: true,
    historical: false,
    evidenceComplete: true,
    classification: 'sibling',
    normalizedUrl: 'https://example.com/places/another',
    matchedTargetIds: ['another-house'],
    matchedUrlIds: ['another-house:url:0'],
  }],
  diagnostics: {
    bridgedObservationIds: ['observation-1'],
    historicalObservationIds: [],
    evidenceIncompleteObservationIds: [],
    ambiguousObservationIds: [],
    unmatchedObservationIds: [],
  },
} as unknown as MeasurementReportResponse

describe('version-one advanced measurement adapter', () => {
  it('preserves bridged Property evidence as Historical while marking class reporting unavailable', () => {
    const adapted = adaptVersionOneMeasurementReport(activePlan, report)

    expect(adapted.classReporting).toBe('plan-v1')
    expect(adapted.latestMeasurement.status.label).toBe('Complete')
    expect(adapted.latestMeasurement.date).toBe('Aug 2, 2026')
    expect(adapted.overall.aggregate.properties[0]).toMatchObject({
      id: 'harbor-house',
      name: 'Harbor House',
      assignedQueries: ['event venues near the harbor'],
      urls: ['https://example.com/places/harbor'],
      historical: true,
    })
    expect(adapted.overall.aggregate.properties[0]!.evidence[0]).toMatchObject({
      kind: 'another-property',
      historical: true,
    })
  })

  it('carries the answers a revision report left out of a mention rate', () => {
    const partial = structuredClone(report)
    partial.targets[0]!.mentionCoverage = { numerator: 1, denominator: 1, rate: 1, unattributed: 9 }
    const adapted = adaptVersionOneMeasurementReport(activePlan, partial)
    expect(adapted.overall.aggregate.properties[0]!.mentionCoverage).toEqual({ numerator: 1, denominator: 1, unattributed: 9 })
    expect(adapted.overall.aggregate.properties[0]!.citationCoverage).toEqual({ numerator: 1, denominator: 1 })
  })

  it('reports legacy completeness and bridged provenance even without citation evidence', () => {
    const adapted = adaptVersionOneMeasurementReport(activePlan, {
      ...report,
      run: { ...report.run, status: 'partial' },
      targets: [{
        ...report.targets[0]!,
        completeness: {
          ...report.targets[0]!.completeness,
          executed: 1,
          expected: 2,
          complete: false,
        },
      }],
      evidence: [],
      diagnostics: {
        ...report.diagnostics,
        bridgedObservationIds: ['observation-without-a-citation'],
      },
    })

    expect(adapted.latestMeasurement).toMatchObject({
      completedSlots: 0,
      totalSlots: 0,
      includesBridgedHistory: true,
    })
    expect(adapted.overall!.aggregate.properties[0]!.status.label).toBe('Incomplete · 1 of 2')
  })

  it('uses unique execution slots for a completed legacy run instead of summing shared Property totals', () => {
    const adapted = adaptVersionOneMeasurementReport(activePlan, {
      ...report,
      targets: [
        report.targets[0]!,
        { ...report.targets[0]!, id: 'second-house', label: 'Second House' },
      ],
    })

    expect(adapted.latestMeasurement).toMatchObject({ completedSlots: 1, totalSlots: 1 })
  })

  it('marks the run as historical when legacy observations were recovered without bridging', () => {
    const adapted = adaptVersionOneMeasurementReport(activePlan, {
      ...report,
      evidence: [],
      diagnostics: {
        ...report.diagnostics,
        bridgedObservationIds: [],
        historicalObservationIds: ['observation-1'],
      },
    })

    expect(adapted.latestMeasurement.includesBridgedHistory).toBe(true)
  })

  it('indexes each legacy evidence row once before adapting Properties', () => {
    const indexed = indexVersionOneEvidenceByTarget(report.evidence)

    expect(indexed.get('harbor-house')).toHaveLength(1)
    expect(indexed.get('missing-property')).toBeUndefined()
  })
})
