import { CitationStates, percentOf, RetrievalStatuses, type ProjectOverviewProviderScoreDto, type RetrievalStatus } from '@canonry/canonry-contracts'

export interface ProviderScoreSnapshot {
  provider: string
  model: string | null
  citationState: string
  /** Absent / null for rows written before retrieval was recorded: they stay in the cited denominator. */
  retrievalStatus?: RetrievalStatus | null
}

/**
 * Per-(provider, model) citation score for the latest run: `cited / total`
 * snapshots as 0..100 at wire precision. Distinct from
 * `ProjectOverviewProviderEntryDto`, which collapses across models. The
 * dashboard shows one row per (provider, model) pair sorted by provider then
 * model name.
 *
 * An answer the provider wrote with no retrieval step at all
 * (`retrievalStatus = 'not-used'`) cites nothing by construction, so it
 * leaves the cited numerator AND denominator rather than counting as a
 * searched miss, and is counted in `excludedNoRetrieval`. Rows that predate
 * retrieval recording (`retrievalStatus` null / absent) are NOT excluded —
 * an unobserved absence is not an observed one.
 */
export function buildProviderScores(
  snapshots: readonly ProviderScoreSnapshot[],
): ProjectOverviewProviderScoreDto[] {
  const modelGroups = new Map<string, { provider: string; model: string | null; cited: number; total: number; excludedNoRetrieval: number }>()
  for (const snap of snapshots) {
    const provider = snap.provider
    const model = snap.model ?? null
    const key = `${provider}::${model ?? 'unknown'}`
    const group = modelGroups.get(key) ?? { provider, model, cited: 0, total: 0, excludedNoRetrieval: 0 }
    if (snap.retrievalStatus === RetrievalStatuses['not-used']) {
      group.excludedNoRetrieval++
    } else {
      group.total++
      if (snap.citationState === CitationStates.cited) group.cited++
    }
    modelGroups.set(key, group)
  }

  return [...modelGroups.values()]
    .sort((a, b) =>
      a.provider.localeCompare(b.provider)
      || (a.model ?? '').localeCompare(b.model ?? ''),
    )
    .map(({ provider, model, cited, total, excludedNoRetrieval }) => ({
      provider,
      model,
      score: percentOf(cited, total) ?? 0,
      cited,
      total,
      // Present only when nonzero, so a smaller cited denominator is always
      // visible next to the rate it shrank.
      ...(excludedNoRetrieval > 0 ? { excludedNoRetrieval } : {}),
    }))
}
