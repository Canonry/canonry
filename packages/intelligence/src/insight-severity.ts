/**
 * Pure severity tiering for regression insights.
 *
 * The two signals consulted (search demand + recurrence) are derived by the
 * caller from data the analyzer doesn't have access to (GSC impressions,
 * prior `insights` rows). Keeping the rule pure lets the dashboard, CLI,
 * Aero, and the report renderer all classify the same way without each
 * re-implementing the thresholds.
 *
 * When both signals are unknown the function returns `'high'`, which
 * preserves the pre-existing default severity for regressions and keeps
 * existing call sites that don't yet supply the signals stable.
 */

import type { InsightSeverity } from './types.js'

export const SEVERITY_THRESHOLDS = {
  highTrafficImpressions: 100,
  recurrenceCount: 2,
  mediumTrafficImpressions: 10,
} as const

export interface SeveritySignals {
  /** GSC impressions for the regressed keyword over the report window. */
  gscImpressions?: number
  /** How many prior runs in recent history flagged this same (keyword, provider) regression. */
  recurrenceCount?: number
}

export function classifyRegressionSeverity(signals: SeveritySignals): InsightSeverity {
  const { gscImpressions, recurrenceCount } = signals

  // Both unknown → preserve legacy 'high' default rather than guessing 'low'.
  if (gscImpressions === undefined && recurrenceCount === undefined) return 'high'

  const isHighTraffic = gscImpressions !== undefined
    && gscImpressions >= SEVERITY_THRESHOLDS.highTrafficImpressions
  const isRecurring = recurrenceCount !== undefined
    && recurrenceCount >= SEVERITY_THRESHOLDS.recurrenceCount
  const isModerateTraffic = gscImpressions !== undefined
    && gscImpressions >= SEVERITY_THRESHOLDS.mediumTrafficImpressions

  if (isHighTraffic && isRecurring) return 'critical'
  if (isHighTraffic || isRecurring) return 'high'
  if (isModerateTraffic) return 'medium'
  return 'low'
}
