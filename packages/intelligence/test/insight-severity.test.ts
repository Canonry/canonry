import { describe, expect, test } from 'vitest'
import { classifyRegressionSeverity } from '../src/insight-severity.js'

describe('classifyRegressionSeverity', () => {
  test('returns "critical" when both high traffic and recurrence are present', () => {
    expect(classifyRegressionSeverity({ gscImpressions: 500, recurrenceCount: 3 })).toBe('critical')
    expect(classifyRegressionSeverity({ gscImpressions: 100, recurrenceCount: 2 })).toBe('critical')
  })

  test('returns "high" when only one signal qualifies', () => {
    expect(classifyRegressionSeverity({ gscImpressions: 500, recurrenceCount: 1 })).toBe('high')
    expect(classifyRegressionSeverity({ gscImpressions: 50, recurrenceCount: 3 })).toBe('high')
  })

  test('returns "medium" when traffic is moderate and no recurrence', () => {
    expect(classifyRegressionSeverity({ gscImpressions: 25, recurrenceCount: 0 })).toBe('medium')
    expect(classifyRegressionSeverity({ gscImpressions: 10, recurrenceCount: 1 })).toBe('medium')
  })

  test('returns "low" when neither signal qualifies', () => {
    expect(classifyRegressionSeverity({ gscImpressions: 0, recurrenceCount: 0 })).toBe('low')
    expect(classifyRegressionSeverity({ gscImpressions: 5, recurrenceCount: 0 })).toBe('low')
  })

  test('falls back to "high" when both signals are undefined (no GSC, no history)', () => {
    expect(classifyRegressionSeverity({})).toBe('high')
    expect(classifyRegressionSeverity({ gscImpressions: undefined, recurrenceCount: undefined })).toBe('high')
  })

  test('treats undefined as "no signal" — does not silently coerce to 0', () => {
    // Only GSC unknown — should not promote to "low"; recurrence carries the
    // signal and we have nothing to add about traffic.
    expect(classifyRegressionSeverity({ recurrenceCount: 3 })).toBe('high')
    expect(classifyRegressionSeverity({ gscImpressions: 500 })).toBe('high')
  })
})
