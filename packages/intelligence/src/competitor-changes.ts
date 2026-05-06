import type { RunData, CompetitorChange } from './types.js'

interface BuildOptions {
  trackedCompetitors: readonly string[]
}

function buildCompetitorQueryMap(run: RunData, tracked: Set<string>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const snap of run.snapshots) {
    if (!snap.query || !snap.competitorDomains || snap.competitorDomains.length === 0) continue
    for (const domain of snap.competitorDomains) {
      if (!tracked.has(domain)) continue
      const existing = result.get(domain) ?? new Set<string>()
      existing.add(snap.query)
      result.set(domain, existing)
    }
  }
  return result
}

/**
 * Tracked competitors that started showing up on queries where they did not
 * appear in the previous run. One entry per (query, competitor) pair.
 */
export function detectCompetitorGains(
  currentRun: RunData,
  previousRun: RunData,
  opts: BuildOptions,
): CompetitorChange[] {
  const tracked = new Set(opts.trackedCompetitors)
  if (tracked.size === 0) return []

  const currentMap = buildCompetitorQueryMap(currentRun, tracked)
  const previousMap = buildCompetitorQueryMap(previousRun, tracked)

  const result: CompetitorChange[] = []
  for (const competitorDomain of tracked) {
    const currentQs = currentMap.get(competitorDomain) ?? new Set<string>()
    const previousQs = previousMap.get(competitorDomain) ?? new Set<string>()
    for (const query of currentQs) {
      if (previousQs.has(query)) continue
      result.push({ query, competitorDomain })
    }
  }
  return result
}

/**
 * Tracked competitors that disappeared from queries where they appeared in
 * the previous run. One entry per (query, competitor) pair.
 */
export function detectCompetitorLosses(
  currentRun: RunData,
  previousRun: RunData,
  opts: BuildOptions,
): CompetitorChange[] {
  const tracked = new Set(opts.trackedCompetitors)
  if (tracked.size === 0) return []

  const currentMap = buildCompetitorQueryMap(currentRun, tracked)
  const previousMap = buildCompetitorQueryMap(previousRun, tracked)

  const result: CompetitorChange[] = []
  for (const competitorDomain of tracked) {
    const currentQs = currentMap.get(competitorDomain) ?? new Set<string>()
    const previousQs = previousMap.get(competitorDomain) ?? new Set<string>()
    for (const query of previousQs) {
      if (currentQs.has(query)) continue
      result.push({ query, competitorDomain })
    }
  }
  return result
}
