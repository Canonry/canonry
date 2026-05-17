/**
 * AEO-first action classifier for the content recommendation engine.
 *
 * Decision tree (intentionally checks AI citation status BEFORE SEO rank
 * — this is an AEO tool, not a generic SEO tool):
 *
 *   no page                              → CREATE
 *   ourPage is homepage-only             → CREATE  (see HOMEPAGE_ONLY_PATHS)
 *   cited + no schema                    → ADD-SCHEMA  (lock in the win)
 *   cited + has schema                   → null         (already winning)
 *   cited + audit unavailable            → null         (no actionable info)
 *   not cited + position ≤ 10            → REFRESH      (SEO works, AEO doesn't)
 *   not cited + position 11–30           → EXPAND       (thin/stale)
 *   not cited + position > 30 or no page → CREATE       (effectively invisible)
 *
 * Homepage-only exception (why CREATE, not REFRESH):
 *   Google routinely ranks a site's homepage for service/topic queries
 *   the brand is associated with — "spray foam insulation" → homepage of
 *   a coatings business, "polyurea roofing" → homepage of a roofing
 *   business. GSC reports this as `page = '/'` with a strong position,
 *   which makes it LOOK like "we have a top-ranking page" to the
 *   classifier. But the homepage isn't a *topical* page for the query:
 *   it doesn't directly answer the user's question, and refreshing the
 *   homepage to specifically address one query would damage every other
 *   query the homepage targets.
 *
 *   The right recommendation in this scenario is to CREATE a topical
 *   page for the query, not to REFRESH the homepage. The downstream
 *   evidence still surfaces "homepage is the closest slug match" so the
 *   user sees what's happening — just with an action that matches the
 *   AEO-first thesis.
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

/**
 * Paths that the orchestrator may resolve as `ourPage.url` but should
 * NOT count as a topical page for refresh/expand/add-schema decisions.
 * `extractPath` in content-data.ts normalizes URLs to a stripped path,
 * with the homepage rendered as `/` (and the empty-string fallback as a
 * defensive case for malformed GSC rows).
 */
function isHomepageOnly(url: string): boolean {
  if (url === '/' || url === '') return true
  // Strip query strings + trailing slashes that survived normalization
  // (defensive — extractPath should have handled these, but a quirky GSC
  // row could still hit us with `/?utm=…`).
  const stripped = url.split('?')[0]!.replace(/\/+$/, '')
  return stripped === '' || stripped === '/'
}

export function classifyContentAction(input: ClassifierInput): ContentAction | null {
  const { ourPage, ourPageInGroundingSources, ourPageHasSchema } = input

  if (!ourPage) return 'create'

  // Homepage-only match: see header comment. The homepage ranking for a
  // topical query is almost always brand-match behavior, not "we have a
  // topical page." CREATE a real page; don't suggest refreshing the
  // homepage.
  if (isHomepageOnly(ourPage.url)) return 'create'

  if (ourPageInGroundingSources) {
    if (ourPageHasSchema === false) return 'add-schema'
    return null
  }

  // Not cited — SEO triage decides which not-cited action fits.
  if (ourPage.position <= SEO_STRONG_THRESHOLD) return 'refresh'
  if (ourPage.position <= SEO_WEAK_THRESHOLD) return 'expand'
  return 'create'
}
