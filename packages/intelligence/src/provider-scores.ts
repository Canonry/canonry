import { CitationStates, isCitationStateMeasured, percentOf, type CitationState, type ProjectOverviewProviderScoreDto } from '@canonry/canonry-contracts'

export interface ProviderScoreSnapshot {
  provider: string
  model: string | null
  /** As read through `readCitationState`. */
  citationState: CitationState
}

/**
 * Per-(provider, model) citation score for the latest run: `cited` over the
 * answers whose sources were checked, as 0..100 at wire precision. Answers
 * whose engine returns no sources are counted in `citationNotMeasured` and
 * left out; with none checked the score is null. Distinct from
 * `ProjectOverviewProviderEntryDto`, which collapses across models. The
 * dashboard shows one row per (provider, model) pair sorted by provider then
 * model name.
 */
export function buildProviderScores(
  snapshots: readonly ProviderScoreSnapshot[],
): ProjectOverviewProviderScoreDto[] {
  const modelGroups = new Map<string, { provider: string; model: string | null; cited: number; total: number; citationNotMeasured: number }>()
  for (const snap of snapshots) {
    const provider = snap.provider
    const model = snap.model ?? null
    const key = `${provider}::${model ?? 'unknown'}`
    const group = modelGroups.get(key) ?? { provider, model, cited: 0, total: 0, citationNotMeasured: 0 }
    group.total++
    if (snap.citationState === CitationStates.cited) group.cited++
    if (!isCitationStateMeasured(snap.citationState)) group.citationNotMeasured++
    modelGroups.set(key, group)
  }

  return [...modelGroups.values()]
    .sort((a, b) =>
      a.provider.localeCompare(b.provider)
      || (a.model ?? '').localeCompare(b.model ?? ''),
    )
    .map(({ provider, model, cited, total, citationNotMeasured }) => ({
      provider,
      model,
      score: percentOf(cited, total - citationNotMeasured),
      cited,
      total,
      citationNotMeasured,
    }))
}
