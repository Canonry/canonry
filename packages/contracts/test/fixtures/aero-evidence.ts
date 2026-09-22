import { visibilityReportResponseSchema, type VisibilityReportResponse } from '@ainyc/canonry-contracts'

export function aeroEvidenceFixture(mode: 'simple' | 'advanced' = 'advanced'): VisibilityReportResponse {
  return visibilityReportResponseSchema.parse({
    selection: {
      mode, queryClass: 'all',
      scope: mode === 'advanced' ? { kind: 'property', id: 'hotel', label: 'Hotel', targetCount: 1 } : { kind: 'project', id: 'project', label: 'Project', targetCount: 1 },
      ...(mode === 'advanced' ? { market: { kind: 'market', id: 'london', label: 'London', targetCount: 1 } } : {}),
      provider: 'openai', model: 'model', location: { kind: 'none' },
      time: { from: null, to: null }, revision: mode === 'advanced' ? 3 : null,
      run: { id: 'run-3', explicit: true },
      provenance: mode === 'advanced' ? { kind: 'frozen-advanced', definitionRevision: 3 } : { kind: 'frozen-simple', definitionRevision: null },
      measurement: { state: 'measured', activeRevision: mode === 'advanced' ? 3 : null, measuredRevision: mode === 'advanced' ? 3 : null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-08-01T00:00:00.000Z' },
      availability: { state: 'available' },
    },
    scopeOptions: [], filterOptions: { providers: ['openai'], models: [], locations: [{ kind: 'none' }] },
    populations: ['branded', 'non-brand', 'unknown'].map(queryClass => {
      const missing = queryClass === 'unknown'
      const mentioned = queryClass === 'branded' ? 10 : 0
      const rate = missing ? { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' } : { numerator: mentioned, denominator: 10, rate: mentioned / 10 }
      return {
        queryClass, summary: {
          queryCount: 10, answerCount: 10, mentionCoverage: rate,
          citationCoverage: missing ? rate : { numerator: 2, denominator: 10, rate: 0.2 },
          propertyReach: { numerator: null, denominator: null, rate: null, reason: 'not-applicable' },
          outcomes: { bothSignals: mentioned ? 2 : 0, mentionedOnly: mentioned ? 8 : 0, citedOnly: mentioned ? 0 : 2, neither: mentioned ? 0 : 8, notMeasured: 0, total: 10 },
        },
        comparison: { state: 'unavailable', reason: 'model-changed', previousRun: { id: 'run-2', createdAt: '2026-07-01T00:00:00.000Z', completedAt: '2026-07-01T00:01:00.000Z' } },
        trend: [], queries: { items: [], total: 10, nextCursor: 'query-page-2' },
        evidence: { items: [], total: 10, nextCursor: 'evidence-page-2' },
        competitorAvailability: { state: 'available' }, competitors: [], observedCompetitors: [],
        breakdown: { properties: [], groups: [] },
      }
    }),
  })
}
