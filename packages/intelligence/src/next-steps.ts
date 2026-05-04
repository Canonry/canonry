/**
 * Pure mapper that auto-populates `recommendedNextSteps` from scored content
 * opportunities when the upstream insight-driven builder produced nothing.
 *
 * Lives in the intelligence package because both the API report builder
 * (api-routes/report.ts) and the HTML renderer (canonry/report-renderer.ts)
 * need to call it — and api-routes cannot import from canonry per the
 * dependency boundary. Pure, no I/O, fully unit-testable.
 *
 * Behavior: when `existing` is non-empty, returned unchanged (insight-derived
 * steps always win). When empty, the top-N opportunities are mapped to
 * action-templated steps with `immediate` horizon for the top 3 and
 * `short-term` for the rest.
 */

import type {
  ContentTargetRowDto,
  ContentAction,
  RecommendedNextStep,
} from '@ainyc/canonry-contracts'
import { ContentActions } from '@ainyc/canonry-contracts'

const TOP_N = 5
const IMMEDIATE_HORIZON = 3

const ACTION_TITLE: Record<ContentAction, (q: string) => string> = {
  [ContentActions.create]: (q) => `Create a page targeting "${q}"`,
  [ContentActions.refresh]: (q) => `Refresh the page targeting "${q}"`,
  [ContentActions.expand]: (q) => `Expand coverage of "${q}"`,
  [ContentActions['add-schema']]: (q) => `Add structured data to the page targeting "${q}"`,
}

export function mapOpportunitiesToNextSteps(
  opportunities: ContentTargetRowDto[],
  existing: RecommendedNextStep[],
): RecommendedNextStep[] {
  if (existing.length > 0) return existing
  if (opportunities.length === 0) return []

  return opportunities.slice(0, TOP_N).map((opp, idx) => ({
    horizon: idx < IMMEDIATE_HORIZON ? 'immediate' : 'short-term',
    title: ACTION_TITLE[opp.action](opp.query),
    rationale: `Score ${Math.round(opp.score)} · demand ${opp.demandSource} · ${opp.actionConfidence} confidence.`,
  }))
}
