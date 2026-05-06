import { CitationStates, type CitationCell, type ProjectReportDto } from '@ainyc/canonry-contracts'

export interface ScorecardSnapshot {
  queryId: string
  provider: string
  model: string | null
  citationState: string
  answerMentioned: boolean | null
}

export interface ScorecardQueryLookup {
  byId: Map<string, string>
}

export function buildCitationScorecard(
  snapshots: readonly ScorecardSnapshot[],
  queryLookup: ScorecardQueryLookup,
): ProjectReportDto['citationScorecard'] {
  if (snapshots.length === 0) {
    return { queries: [], providers: [], matrix: [], providerRates: [] }
  }

  const querySet = new Set<string>()
  const providerSet = new Set<string>()
  for (const snap of snapshots) {
    const q = queryLookup.byId.get(snap.queryId)
    if (!q) continue
    querySet.add(q)
    providerSet.add(snap.provider)
  }
  const queryList = [...querySet].sort()
  const providerList = [...providerSet].sort()

  const matrix: Array<Array<CitationCell | null>> = queryList.map(() =>
    providerList.map(() => null),
  )
  const providerCounts = new Map<string, { cited: number; total: number }>()

  for (const snap of snapshots) {
    const q = queryLookup.byId.get(snap.queryId)
    if (!q) continue
    const qi = queryList.indexOf(q)
    const pi = providerList.indexOf(snap.provider)
    if (qi < 0 || pi < 0) continue
    matrix[qi]![pi] = {
      citationState: snap.citationState === CitationStates.cited ? 'cited' : 'not-cited',
      answerMentioned: snap.answerMentioned ?? null,
      model: snap.model,
    }
    const counts = providerCounts.get(snap.provider) ?? { cited: 0, total: 0 }
    counts.total++
    if (snap.citationState === CitationStates.cited) counts.cited++
    providerCounts.set(snap.provider, counts)
  }

  const providerRates = providerList.map(provider => {
    const counts = providerCounts.get(provider) ?? { cited: 0, total: 0 }
    const citationRate = counts.total > 0 ? Math.round((counts.cited / counts.total) * 100) : 0
    return {
      provider,
      citedCount: counts.cited,
      totalCount: counts.total,
      citationRate,
    }
  })

  return { queries: queryList, providers: providerList, matrix, providerRates }
}
