import { describe, expect, it } from 'vitest'
import {
  buildMentionCoverage,
  type MentionCoverageSnapshot,
} from '../src/mention-coverage.js'

function snap(overrides: Partial<MentionCoverageSnapshot> = {}): MentionCoverageSnapshot {
  return {
    queryId: 'q1',
    provider: 'gemini',
    answerMentioned: true,
    ...overrides,
  }
}

describe('buildMentionCoverage', () => {
  it('labels itself accurately for the mention signal it counts', () => {
    const result = buildMentionCoverage([snap()], { configuredApiProviders: ['gemini'] })
    expect(result.label).toBe('Mention Coverage')
  })

  it('returns "No data" tone:neutral when there are no snapshots', () => {
    const result = buildMentionCoverage([], { configuredApiProviders: ['gemini', 'openai'] })
    expect(result.value).toBe('No data')
    expect(result.tone).toBe('neutral')
    expect(result.progress).toBeUndefined()
    expect(result.providerCoverage).toBeUndefined()
  })

  it('computes score as the rounded percentage of mentioned queries', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: true }),
      snap({ queryId: 'q2', answerMentioned: true }),
      snap({ queryId: 'q3', answerMentioned: false }),
    ]
    const result = buildMentionCoverage(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.value).toBe('67')
    expect(result.progress).toBe(67)
    expect(result.delta).toBe('2 of 3 queries mentioned')
  })

  it('treats a query as mentioned when ANY provider snapshot has answerMentioned=true', () => {
    const snapshots = [
      snap({ queryId: 'q1', provider: 'gemini', answerMentioned: false }),
      snap({ queryId: 'q1', provider: 'openai', answerMentioned: true }),
    ]
    const result = buildMentionCoverage(snapshots, { configuredApiProviders: ['gemini', 'openai'] })
    expect(result.value).toBe('100')
  })

  it('treats null/undefined answerMentioned as not-mentioned', () => {
    // Pre-PR-#500 snapshots may have null answerMentioned. They should not
    // inflate the cited count.
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: null }),
      snap({ queryId: 'q2', answerMentioned: undefined }),
      snap({ queryId: 'q3', answerMentioned: true }),
    ]
    const result = buildMentionCoverage(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.value).toBe('33')
    expect(result.delta).toBe('1 of 3 queries mentioned')
  })

  it('applies scoreTone: positive when score >= 70', () => {
    const snapshots = Array.from({ length: 8 }, (_, i) =>
      snap({ queryId: `q${i}`, answerMentioned: true }),
    ).concat(Array.from({ length: 2 }, (_, i) =>
      snap({ queryId: `q${i + 8}`, answerMentioned: false }),
    ))
    const result = buildMentionCoverage(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.tone).toBe('positive')
  })

  it('applies scoreTone: caution when score in [40, 70)', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: true }),
      snap({ queryId: 'q2', answerMentioned: true }),
      snap({ queryId: 'q3', answerMentioned: false }),
      snap({ queryId: 'q4', answerMentioned: false }),
    ]
    const result = buildMentionCoverage(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.tone).toBe('caution')
  })

  it('applies scoreTone: negative when score < 40', () => {
    const snapshots = [
      snap({ queryId: 'q1', answerMentioned: true }),
      snap({ queryId: 'q2', answerMentioned: false }),
      snap({ queryId: 'q3', answerMentioned: false }),
      snap({ queryId: 'q4', answerMentioned: false }),
    ]
    const result = buildMentionCoverage(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.tone).toBe('negative')
  })

  it('overrides tone to caution and sets providerCoverage when only some providers ran', () => {
    const snapshots = [snap({ provider: 'gemini', answerMentioned: true })]
    const result = buildMentionCoverage(snapshots, {
      configuredApiProviders: ['gemini', 'openai', 'claude'],
    })
    expect(result.tone).toBe('caution')
    expect(result.providerCoverage).toBe('1 of 3 providers')
  })

  it('does not flag partial coverage when only one provider is configured', () => {
    const snapshots = [snap({ provider: 'gemini', answerMentioned: true })]
    const result = buildMentionCoverage(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.providerCoverage).toBeUndefined()
    expect(result.tone).toBe('positive')
  })

  it('does not flag partial coverage when all configured providers ran', () => {
    const snapshots = [
      snap({ queryId: 'q1', provider: 'gemini', answerMentioned: true }),
      snap({ queryId: 'q1', provider: 'openai', answerMentioned: true }),
    ]
    const result = buildMentionCoverage(snapshots, {
      configuredApiProviders: ['gemini', 'openai'],
    })
    expect(result.providerCoverage).toBeUndefined()
  })
})
