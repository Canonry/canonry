import { CitationStates, type ProjectOverviewProviderScoreDto } from '@ainyc/canonry-contracts'

export interface ProviderScoreSnapshot {
  provider: string
  model: string | null
  citationState: string
}

/**
 * Per-(provider, model) citation score for the latest run. Distinct from
 * `ProjectOverviewProviderEntryDto`, which collapses across models. The
 * dashboard shows one row per (provider, model) pair sorted by provider then
 * model name.
 */
export function buildProviderScores(
  snapshots: readonly ProviderScoreSnapshot[],
): ProjectOverviewProviderScoreDto[] {
  const modelGroups = new Map<string, { provider: string; model: string | null; cited: number; total: number }>()
  for (const snap of snapshots) {
    const provider = snap.provider
    const model = snap.model ?? null
    const key = `${provider}::${model ?? 'unknown'}`
    const group = modelGroups.get(key) ?? { provider, model, cited: 0, total: 0 }
    group.total++
    if (snap.citationState === CitationStates.cited) group.cited++
    modelGroups.set(key, group)
  }

  return [...modelGroups.values()]
    .sort((a, b) =>
      a.provider.localeCompare(b.provider)
      || (a.model ?? '').localeCompare(b.model ?? ''),
    )
    .map(({ provider, model, cited, total }) => ({
      provider,
      model,
      score: total > 0 ? Math.round((cited / total) * 100) : 0,
      cited,
      total,
    }))
}
