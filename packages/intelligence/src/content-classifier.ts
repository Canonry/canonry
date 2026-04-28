/**
 * AEO-first action classifier for the content recommendation engine.
 *
 * Decision tree (intentionally checks AI citation status BEFORE SEO rank
 * — this is an AEO tool, not a generic SEO tool):
 *
 *   no page                              → CREATE
 *   cited + no schema                    → ADD-SCHEMA  (lock in the win)
 *   cited + has schema                   → null         (already winning)
 *   cited + audit unavailable            → null         (no actionable info)
 *   not cited + position ≤ 10            → REFRESH      (SEO works, AEO doesn't)
 *   not cited + position 11–30           → EXPAND       (thin/stale)
 *   not cited + position > 30 or no page → CREATE       (effectively invisible)
 */

import type { ContentAction } from '@ainyc/canonry-contracts'

export interface ClassifierInput {
  ourPage: { url: string; position: number; source: 'gsc' | 'inventory' } | null
  /** Is our domain/url present in groundingSources for this query? */
  ourPageInGroundingSources: boolean
  /** Schema audit result: true=has, false=missing, null=audit unavailable. */
  ourPageHasSchema: boolean | null
}

const SEO_STRONG_THRESHOLD = 10
const SEO_WEAK_THRESHOLD = 30

export function classifyContentAction(input: ClassifierInput): ContentAction | null {
  const { ourPage, ourPageInGroundingSources, ourPageHasSchema } = input

  if (!ourPage) return 'create'

  if (ourPageInGroundingSources) {
    if (ourPageHasSchema === false) return 'add-schema'
    return null
  }

  // Not cited — SEO triage decides which not-cited action fits.
  if (ourPage.position <= SEO_STRONG_THRESHOLD) return 'refresh'
  if (ourPage.position <= SEO_WEAK_THRESHOLD) return 'expand'
  return 'create'
}
