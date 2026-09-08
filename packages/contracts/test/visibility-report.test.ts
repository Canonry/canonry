import { describe, expect, it } from 'vitest'
import {
  visibilityReportQuerySchema,
  visibilityReportResponseSchema,
} from '../src/visibility-report.js'

describe('visibility report contract', () => {
  it('defaults to the non-brand population and preserves explicit no-location', () => {
    expect(visibilityReportQuerySchema.parse({ location: 'none' })).toMatchObject({
      mode: 'auto',
      queryClass: 'non-brand',
      scope: 'project',
      location: { kind: 'none' },
    })
  })

  it('requires a scope key for a group, market, or Property selection', () => {
    expect(visibilityReportQuerySchema.safeParse({ scope: 'market' }).success).toBe(false)
    expect(visibilityReportQuerySchema.parse({ scope: 'market', scopeKey: 'alpha' })).toMatchObject({
      scope: 'market',
      scopeKey: 'alpha',
    })
  })

  it('keeps all classes as side-by-side populations rather than a pooled headline', () => {
    const parsed = visibilityReportResponseSchema.parse({
      selection: {
        mode: 'advanced',
        queryClass: 'all',
        scope: { kind: 'market', id: 'alpha', label: 'Alpha', targetCount: 1 },
        provider: null,
        model: null,
        location: { kind: 'exact', value: 'Alpha' },
        time: { from: null, to: null },
        revision: 3,
        run: { id: 'run-3', explicit: false },
        provenance: { kind: 'frozen-advanced', definitionRevision: 3 },
        measurement: { state: 'measured', activeRevision: 3, measuredRevision: 3, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-09-04T12:00:00.000Z' },
        availability: { state: 'available' },
      },
      scopeOptions: [
        { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
        { id: 'alpha', label: 'Alpha', kind: 'market', targetCount: 1 },
      ],
      filterOptions: { providers: ['openai'], models: [{ provider: 'openai', model: 'gpt-5' }], locations: [{ kind: 'exact', value: 'Alpha' }] },
      populations: [
        population('branded'),
        population('non-brand'),
        population('unknown'),
      ],
    })

    expect(parsed.populations.map(population => population.queryClass)).toEqual([
      'branded',
      'non-brand',
      'unknown',
    ])
    expect('summary' in parsed).toBe(false)
  })

  it('requires each server-owned rate to carry its denominator', () => {
    const response = {
      selection: {
        mode: 'simple',
        queryClass: 'non-brand',
        scope: { kind: 'project', id: 'project', label: 'Project', targetCount: 1 },
        provider: null,
        model: null,
        location: { kind: 'all' },
        time: { from: null, to: null },
        revision: null,
        run: { id: null, explicit: false },
        provenance: { kind: 'legacy-simple', definitionRevision: null },
        measurement: { state: 'not-measured', activeRevision: null, measuredRevision: null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: null },
        availability: { state: 'available' },
      },
      scopeOptions: [{ id: 'project', label: 'Project', kind: 'project', targetCount: 1 }],
      filterOptions: { providers: [], models: [], locations: [{ kind: 'all' }] },
      populations: [population('non-brand')],
    }
    expect(visibilityReportResponseSchema.safeParse(response).success).toBe(true)

    const missingDenominator = structuredClone(response)
    delete (missingDenominator.populations[0] as { summary: { mentionCoverage: Record<string, unknown> } }).summary.mentionCoverage.denominator
    expect(visibilityReportResponseSchema.safeParse(missingDenominator).success).toBe(false)
  })
})

function population(queryClass: 'branded' | 'non-brand' | 'unknown') {
  return {
    queryClass,
    summary: {
      queryCount: 1,
      answerCount: 1,
      mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
      citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
      propertyReach: { numerator: 1, denominator: 1, rate: 1 },
      outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 },
    },
    trend: [{
      runId: 'run-3',
      createdAt: '2026-09-04T12:00:00.000Z',
      revision: 3,
      provenance: { kind: 'frozen-advanced', definitionRevision: 3 },
      queryCount: 1,
      answerCount: 1,
      mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
      citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
      continuity: { state: 'first', comparedRunId: null },
    }],
    queries: { items: [{
      queryKey: 'question:1',
      queryId: 'q1',
      query: 'What is Northstar?',
      provider: 'openai',
      model: 'gpt-5',
      location: 'Alpha',
      targetKeys: ['property:1'],
      answerCount: 1,
      mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
      citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
    }], nextCursor: null, total: 1 },
    evidence: { items: [{
      answerId: 'answer:1',
      runId: 'run-3',
      queryKey: 'question:1',
      query: 'What is Northstar?',
      provider: 'openai',
      model: 'gpt-5',
      location: 'Alpha',
      targetKeys: ['property:1'],
      mentioned: true,
      cited: true,
      answerText: null,
      createdAt: '2026-09-04T12:00:00.000Z',
      sources: ['https://northstar.example/'],
      observedCompetitors: [],
    }], nextCursor: null, total: 1 },
    competitorAvailability: { state: 'available' },
    competitors: [{
      domain: 'challenger.example',
      answerCount: 1,
      mentionCoverage: { numerator: 0, denominator: 1, rate: 0 },
      citationCoverage: { numerator: 0, denominator: 1, rate: 0 },
    }],
    observedCompetitors: [],
    breakdown: {
      properties: [{
        id: 'property:1',
        label: 'Property 1',
        queryCount: 1,
        mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
        citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
      }],
      groups: [],
    },
  }
}
