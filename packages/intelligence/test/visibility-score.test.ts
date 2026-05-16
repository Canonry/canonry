import { describe, expect, it } from 'vitest'
import {
  buildVisibilityScore,
  type VisibilityScoreSnapshot,
} from '../src/visibility-score.js'

function snap(overrides: Partial<VisibilityScoreSnapshot> = {}): VisibilityScoreSnapshot {
  return {
    queryId: 'q1',
    provider: 'gemini',
    citationState: 'cited',
    ...overrides,
  }
}

describe('buildVisibilityScore', () => {
  it('labels itself accurately for the citation signal it counts', () => {
    // The function reads `citationState === 'cited'` exclusively (not
    // `answerMentioned`). Per AGENTS.md vocabulary rule 3, the label must
    // describe what's actually being measured. Historically this gauge was
    // labelled "Answer Visibility" — a phrase that implies the mention
    // signal under the legacy alias rules — but the math is pure citation.
    // The rename makes label and data consistent.
    const result = buildVisibilityScore([snap()], { configuredApiProviders: ['gemini'] })
    expect(result.label).toBe('Citation Coverage')
  })

  it('returns "No data" tone:neutral when there are no snapshots', () => {
    const result = buildVisibilityScore([], { configuredApiProviders: ['gemini', 'openai'] })
    expect(result.value).toBe('No data')
    expect(result.tone).toBe('neutral')
    expect(result.progress).toBeUndefined()
    expect(result.providerCoverage).toBeUndefined()
  })

  it('computes score as the rounded percentage of cited queries', () => {
    const snapshots = [
      snap({ queryId: 'q1', citationState: 'cited' }),
      snap({ queryId: 'q2', citationState: 'cited' }),
      snap({ queryId: 'q3', citationState: 'not-cited' }),
    ]
    const result = buildVisibilityScore(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.value).toBe('67')
    expect(result.progress).toBe(67)
    // Delta vocabulary tracks the label vocabulary — "cited", not "visible".
    expect(result.delta).toBe('2 of 3 queries cited')
  })

  it('treats a query as cited when ANY provider snapshot is cited', () => {
    const snapshots = [
      snap({ queryId: 'q1', provider: 'gemini', citationState: 'not-cited' }),
      snap({ queryId: 'q1', provider: 'openai', citationState: 'cited' }),
    ]
    const result = buildVisibilityScore(snapshots, { configuredApiProviders: ['gemini', 'openai'] })
    expect(result.value).toBe('100')
  })

  it('applies scoreTone: positive when score >= 70', () => {
    const snapshots = [
      snap({ queryId: 'q1' }),
      snap({ queryId: 'q2' }),
      snap({ queryId: 'q3' }),
      snap({ queryId: 'q4' }),
      snap({ queryId: 'q5' }),
      snap({ queryId: 'q6' }),
      snap({ queryId: 'q7' }),
      snap({ queryId: 'q8', citationState: 'not-cited' }),
      snap({ queryId: 'q9', citationState: 'not-cited' }),
      snap({ queryId: 'q10', citationState: 'not-cited' }),
    ]
    const result = buildVisibilityScore(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.tone).toBe('positive')
  })

  it('applies scoreTone: caution when score in [40, 70)', () => {
    const snapshots = [
      snap({ queryId: 'q1' }),
      snap({ queryId: 'q2' }),
      snap({ queryId: 'q3', citationState: 'not-cited' }),
      snap({ queryId: 'q4', citationState: 'not-cited' }),
    ]
    const result = buildVisibilityScore(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.tone).toBe('caution')
  })

  it('applies scoreTone: negative when score < 40', () => {
    const snapshots = [
      snap({ queryId: 'q1' }),
      snap({ queryId: 'q2', citationState: 'not-cited' }),
      snap({ queryId: 'q3', citationState: 'not-cited' }),
      snap({ queryId: 'q4', citationState: 'not-cited' }),
    ]
    const result = buildVisibilityScore(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.tone).toBe('negative')
  })

  it('overrides tone to caution and sets providerCoverage when only some providers ran', () => {
    const snapshots = [
      snap({ provider: 'gemini', citationState: 'cited' }),
    ]
    const result = buildVisibilityScore(snapshots, {
      configuredApiProviders: ['gemini', 'openai', 'claude'],
    })
    expect(result.tone).toBe('caution')
    expect(result.providerCoverage).toBe('1 of 3 providers')
  })

  it('does not flag partial coverage when only one provider is configured', () => {
    const snapshots = [snap({ provider: 'gemini', citationState: 'cited' })]
    const result = buildVisibilityScore(snapshots, { configuredApiProviders: ['gemini'] })
    expect(result.providerCoverage).toBeUndefined()
    expect(result.tone).toBe('positive')
  })

  it('does not flag partial coverage when all configured providers ran', () => {
    const snapshots = [
      snap({ queryId: 'q1', provider: 'gemini', citationState: 'cited' }),
      snap({ queryId: 'q1', provider: 'openai', citationState: 'cited' }),
    ]
    const result = buildVisibilityScore(snapshots, {
      configuredApiProviders: ['gemini', 'openai'],
    })
    expect(result.providerCoverage).toBeUndefined()
  })
})
