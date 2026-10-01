import type { QueryClass } from '@ainyc/canonry-contracts'
import type { MetricTone } from '../view-models.js'

/**
 * Query classes for the AI Visibility cards that split by class (the trend,
 * By engine). Branded and non-brand never share a count. A project whose brand
 * identity cannot classify queries gets one `unclassified` class instead.
 * Tested in `apps/web/test/answer-movement.test.ts`.
 */

export type VisibilityRowKey = QueryClass | 'unclassified'

export const VISIBILITY_ROW_ORDER: readonly VisibilityRowKey[] = ['non-brand', 'branded', 'unclassified']

export const VISIBILITY_ROW_LABEL: Record<VisibilityRowKey, string> = {
  'non-brand': 'Non-brand',
  branded: 'Branded',
  unclassified: 'Unclassified',
}

/** Resolves a query's class; `null` when the project cannot classify it. */
export type QueryClassLookup = (queryText: string) => QueryClass | null

/**
 * Tone for a non-brand count: 70% and up positive, the server's top coverage
 * band (`scoreTone`, packages/intelligence/src/score-tones.ts), anything less
 * caution. Never negative, as the approved By engine card draws it: a count
 * says how many queries, and red stays for a loss.
 */
export function coverageTone(count: number, total: number): MetricTone {
  if (total <= 0) return 'neutral'
  return (count / total) * 100 >= 70 ? 'positive' : 'caution'
}
