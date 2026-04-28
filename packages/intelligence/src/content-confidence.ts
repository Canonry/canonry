/**
 * Per-row confidence rating for the action recommendation.
 *
 * Surfaced on every ContentTargetRowDto so agents/UI can downweight
 * low-confidence actions without re-deriving the signal density.
 *
 *   high   — GSC dense (≥100 impressions) AND ≥3 runs of citation history
 *   low    — no GSC AND only the competitor branch fired (single thin signal)
 *   medium — everything in between (sparse GSC, short history, inventory-only match)
 *
 * Thresholds are documented in code (not tunable runtime config) — change
 * the constant + run the snapshot tests if a new threshold is needed.
 */

import type { ActionConfidence } from '@ainyc/canonry-contracts'

export interface ConfidenceInput {
  hasGsc: boolean
  gscImpressions: number
  runsOfHistory: number
  hasCompetitorEvidence: boolean
  hasInventoryMatch: boolean
}

const GSC_DENSE_IMPRESSIONS_THRESHOLD = 100
const RUN_HISTORY_HIGH_CONFIDENCE_THRESHOLD = 3

export function calculateActionConfidence(input: ConfidenceInput): ActionConfidence {
  const gscDense = input.hasGsc && input.gscImpressions >= GSC_DENSE_IMPRESSIONS_THRESHOLD
  const historyDeep = input.runsOfHistory >= RUN_HISTORY_HIGH_CONFIDENCE_THRESHOLD

  if (gscDense && historyDeep) return 'high'

  // Low confidence: we have nothing other than a competitor signal (or nothing at all).
  if (!input.hasGsc && !input.hasInventoryMatch) {
    return 'low'
  }

  return 'medium'
}
