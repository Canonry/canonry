import { describe, expect, it } from 'vitest'
import {
  buildMeasurementRunManifestV1,
  measurementAnswerEvidenceSchema,
  measurementAttributionClassSchema,
  measurementDiscoveryRequestSchema,
  measurementDiscoveryResponseSchema,
  measurementPropertyEvidenceResponseSchema,
  measurementRateSchema,
  measurementReportResponseSchema,
  measurementRunManifestV1Schema,
} from '../src/measurement-service.js'

const CONTEXT = { label: 'Northbridge', city: 'Northbridge', region: 'NB', country: 'US' }

const ANSWER_EVIDENCE = {
  observationId: 'snap-1',
  expectedSlotId: 'slot-1',
  executionId: 'exec-1',
  usageEdgeId: 'target-harbor',
  usageEdgeType: 'target',
  provider: 'gemini',
  queryText: 'homes in northbridge',
  location: 'Northbridge',
  queryClass: 'non-brand',
  mentioned: true,
  cited: true,
  sources: [{
    sourceUrl: 'https://northstar.example/locations/harbor',
    normalizedUrl: 'https://northstar.example/locations/harbor',
    classification: 'assigned',
    matchedTargetIds: ['harbor'],
    matchedUrlIds: ['harbor-root'],
  }],
  sourceCount: 1,
  sourcesTruncated: false,
  bridged: false,
  historical: false,
  evidenceComplete: true,
}

describe('measurement service contracts', () => {
  it('accepts the deterministic sitemap discovery request vocabulary', () => {
    expect(measurementDiscoveryRequestSchema.parse({
      sitemapUrl: 'https://northstar.example/sitemap.xml',
      rule: {
        primary: { host: 'northstar.example', pathTemplate: '/locations/{slug}' },
        aliases: [{ host: 'homes.northstar.example', pathTemplate: '/{slug}' }],
        excludedSlugSuffixes: ['-regional'],
      },
    })).toEqual(expect.objectContaining({ sitemapUrl: 'https://northstar.example/sitemap.xml' }))
    expect(measurementDiscoveryRequestSchema.safeParse({
      sitemapUrl: 'ftp://northstar.example/sitemap.xml',
      rule: { primary: { host: 'northstar.example', pathTemplate: '/locations/{slug}' } },
    }).success).toBe(false)
  })

  it('builds a canonical per-run expected-slot manifest', () => {
    const manifest = buildMeasurementRunManifestV1({
      expectedSlots: [
        { executionId: 'exec-b', queryText: 'best homes', provider: ' OpenAI ', context: null },
        { executionId: 'exec-a', queryText: 'homes in northbridge', provider: 'GEMINI', context: CONTEXT, requestedModel: 'model-a' },
      ],
    })

    expect(manifest).toEqual({
      schemaVersion: 1,
      expectedSlots: [
        { executionId: 'exec-a', queryText: 'homes in northbridge', provider: 'gemini', context: CONTEXT, requestedModel: 'model-a' },
        { executionId: 'exec-b', queryText: 'best homes', provider: 'openai', context: null },
      ],
    })
  })

  it('rejects malformed expected-slot manifests', () => {
    expect(measurementRunManifestV1Schema.safeParse({
      schemaVersion: 1,
      expectedSlots: [{ executionId: 'exec-a', queryText: 'homes', provider: 'gemini' }],
    }).success).toBe(false)
    expect(measurementRunManifestV1Schema.safeParse({
      schemaVersion: 2,
      expectedSlots: [],
    }).success).toBe(false)
    expect(measurementRunManifestV1Schema.safeParse({
      schemaVersion: 1,
      expectedSlots: [{ executionId: 'exec-a', queryText: 'homes', provider: ' ', context: null }],
    }).success).toBe(false)
  })

  it('rejects mixed-null metrics and unknown classifications', () => {
    expect(measurementRateSchema.safeParse({ numerator: 1, denominator: null, rate: null, reason: 'incomplete' }).success).toBe(false)
    expect(measurementRateSchema.safeParse({ numerator: null, denominator: null, rate: null }).success).toBe(false)
    // Unattributable answers ride beside a measured rate only.
    expect(measurementRateSchema.parse({ numerator: 9, denominator: 11, rate: 9 / 11, unattributed: 1 }))
      .toEqual({ numerator: 9, denominator: 11, rate: 9 / 11, unattributed: 1 })
    expect(measurementRateSchema.safeParse({ numerator: 9, denominator: 11, rate: 9 / 11, unattributed: 0 }).success).toBe(false)
    expect(measurementRateSchema.safeParse({ numerator: null, denominator: null, rate: null, reason: 'identity-ambiguous', unattributed: 2 }).success).toBe(false)
    expect(measurementAttributionClassSchema.safeParse('unmapped').success).toBe(false)
    expect(measurementDiscoveryResponseSchema.safeParse({
      proposed: [], aliases: [], shared: [], unmatched: [], excluded: [{
        url: 'https://northstar.example/other', canonicalUrl: 'https://northstar.example/other',
        classification: 'unknown', reason: 'excluded-slug',
      }], diagnostics: [],
    }).success).toBe(false)
  })

  it('parses a complete synthetic report response', () => {
    const response = measurementReportResponseSchema.parse({
      revision: 3,
      run: { id: 'run-3', status: 'partial', createdAt: '2026-08-01T00:00:00.000Z', startedAt: null, finishedAt: null },
      groups: [{
        id: 'northbridge',
        label: 'Northbridge',
        targetIds: ['harbor'],
        completeness: { executed: 1, expected: 2, complete: false, sourceComplete: false, sourceCompleteObservations: 0, answerComplete: false },
        answerCoverage: { numerator: null, denominator: null, rate: null, reason: 'incomplete' },
        targetCoverage: { numerator: null, denominator: null, rate: null, reason: 'incomplete' },
        sov: {
          domains: [{ domain: 'northstar.example', own: true, presentIn: null, of: null, reason: 'incomplete' }],
          providers: [],
        },
        providers: [],
      }],
      targets: [{
        id: 'harbor', label: 'Harbor',
        completeness: { executed: 1, expected: 1, complete: true, sourceComplete: true, sourceCompleteObservations: 1, answerComplete: true },
        citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
        mentionCoverage: { numerator: null, denominator: null, rate: null, reason: 'aliasless' },
        providers: [],
      }],
      evidence: [{
        observationId: 'snap-1', expectedSlotId: 'slot-1', executionId: 'exec-1',
        usageEdgeId: 'target-harbor', usageEdgeType: 'target', provider: 'gemini',
        queryText: 'homes in northbridge', location: 'Northbridge', sourceUrl: 'https://northstar.example/locations/harbor',
        bridged: false, historical: false, evidenceComplete: true,
        classification: 'assigned', normalizedUrl: 'https://northstar.example/locations/harbor',
        matchedTargetIds: ['harbor'], matchedUrlIds: ['harbor-root'],
      }],
      diagnostics: {
        bridgedObservationIds: [], historicalObservationIds: [], evidenceIncompleteObservationIds: [],
        ambiguousObservationIds: [], unmatchedObservationIds: [],
      },
    })

    expect(response.groups[0]?.targetIds).toEqual(['harbor'])
    expect(response.evidence[0]?.classification).toBe('assigned')
  })
})

describe('answer-level measurement evidence', () => {
  it('carries both signals on one row with its sources nested', () => {
    const row = measurementAnswerEvidenceSchema.parse(ANSWER_EVIDENCE)

    expect(row.mentioned).toBe(true)
    expect(row.cited).toBe(true)
    expect(row.sources).toEqual([expect.objectContaining({ classification: 'assigned' })])
  })

  it('represents an answer that cited nobody', () => {
    // The whole point of the answer-level shape: a loss is a row, not an
    // absence. It has to survive the wire schema with no sources at all.
    const row = measurementAnswerEvidenceSchema.parse({
      ...ANSWER_EVIDENCE,
      mentioned: false,
      cited: false,
      sources: [],
      sourceCount: 0,
    })

    expect(row.sources).toEqual([])
    expect(row.cited).toBe(false)
  })

  it('keeps an unknown mention null rather than false', () => {
    const row = measurementAnswerEvidenceSchema.parse({ ...ANSWER_EVIDENCE, mentioned: null })

    expect(row.mentioned).toBeNull()
    expect(row.mentioned).not.toBe(false)
    // Absent is a distinct reading, so the field is never allowed to go missing.
    const { mentioned: _mentioned, ...withoutMention } = ANSWER_EVIDENCE
    expect(measurementAnswerEvidenceSchema.safeParse(withoutMention).success).toBe(false)
  })

  it('accepts a row whose usage edge carries no question class', () => {
    const row = measurementAnswerEvidenceSchema.parse({
      ...ANSWER_EVIDENCE,
      usageEdgeType: 'baseline',
      queryClass: null,
    })

    expect(row.queryClass).toBeNull()
    expect(measurementAnswerEvidenceSchema.safeParse({ ...ANSWER_EVIDENCE, queryClass: 'navigational' }).success).toBe(false)
  })

  it('refuses an unknown field and an unknown source classification', () => {
    expect(measurementAnswerEvidenceSchema.safeParse({ ...ANSWER_EVIDENCE, sourceUrl: 'https://northstar.example/' }).success).toBe(false)
    expect(measurementAnswerEvidenceSchema.safeParse({
      ...ANSWER_EVIDENCE,
      sources: [{ ...ANSWER_EVIDENCE.sources[0], classification: 'unmapped' }],
    }).success).toBe(false)
  })

  it('serves exactly one evidence page, naming the shape by which key carries it', () => {
    const base = {
      property: { targetKey: 'harbor', label: 'Harbor Homes' },
      queryClass: 'non-brand' as const,
      measurement: { state: 'complete' as const, displayedRunId: 'run-7' },
    }
    const page = { items: [], nextCursor: null, totalEstimate: 0 }

    expect(measurementPropertyEvidenceResponseSchema.safeParse({ ...base, evidence: page }).success).toBe(true)
    expect(measurementPropertyEvidenceResponseSchema.safeParse({
      ...base,
      answers: { items: [ANSWER_EVIDENCE], nextCursor: null, totalEstimate: 1 },
    }).success).toBe(true)

    // Both would let a reader take the shape it did not ask for as a measured
    // zero; neither leaves it with nothing to read at all.
    expect(measurementPropertyEvidenceResponseSchema.safeParse({ ...base, evidence: page, answers: page }).success).toBe(false)
    expect(measurementPropertyEvidenceResponseSchema.safeParse(base).success).toBe(false)
  })
})
