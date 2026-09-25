import type { CompetitorRow, GroundingSource, ProjectReportDto } from '@ainyc/canonry-contracts'
import { hostMatchesDomain, percentOf } from '@ainyc/canonry-contracts'
import { compileCompetitiveSignalResolver } from './competitive-signals.js'

export interface CompetitorLandscapeSnapshot {
  queryId: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
}

export interface CompetitorLandscapeQueryLookup {
  byId: Map<string, string>
}

export function buildCompetitorLandscape(
  snapshots: readonly CompetitorLandscapeSnapshot[],
  competitorDomains: readonly string[],
  projectDomains: readonly string[],
  queryLookup: CompetitorLandscapeQueryLookup,
): ProjectReportDto['competitorLandscape'] {
  let projectCitationCount = 0
  const competitorMap = new Map<
    string,
    { count: number; queries: Set<string>; pages: Map<string, Set<string>> }
  >()
  for (const c of competitorDomains) {
    competitorMap.set(c, { count: 0, queries: new Set(), pages: new Map() })
  }
  const competitorResolver = compileCompetitiveSignalResolver(competitorDomains)
  const projectResolver = compileCompetitiveSignalResolver(projectDomains)

  for (const snap of snapshots) {
    const q = queryLookup.byId.get(snap.queryId)
    const evidence = {
      citedDomains: snap.citedDomains,
      groundingSources: snap.groundingSources,
    }
    if (projectResolver.resolve(evidence).citedCompetitorDomains.length > 0) {
      projectCitationCount++
    }
    const citedCompetitors = new Set(
      competitorResolver.resolve(evidence).citedCompetitorDomains,
    )

    for (const competitor of competitorDomains) {
      if (citedCompetitors.has(competitor)) {
        const entry = competitorMap.get(competitor)!
        entry.count++
        if (q) entry.queries.add(q)
      }
      for (const gs of snap.groundingSources) {
        if (hostMatchesDomain(gs.uri, competitor)) {
          const entry = competitorMap.get(competitor)!
          const pageQueries = entry.pages.get(gs.uri) ?? new Set<string>()
          if (q) pageQueries.add(q)
          entry.pages.set(gs.uri, pageQueries)
        }
      }
    }
  }

  const totalCitedSlots = projectCitationCount
    + [...competitorMap.values()].reduce((sum, v) => sum + v.count, 0)

  const competitorRows: CompetitorRow[] = [...competitorMap.entries()].map(([domain, data]) => {
    const total = snapshots.length
    const ratio = total > 0 ? data.count / total : 0
    let pressureLabel: CompetitorRow['pressureLabel'] = 'None'
    if (data.count > 0) {
      if (ratio >= 0.5) pressureLabel = 'High'
      else if (ratio >= 0.2) pressureLabel = 'Moderate'
      else pressureLabel = 'Low'
    }
    const sharePct = percentOf(data.count, totalCitedSlots) ?? 0
    const theirCitedPages = [...data.pages.entries()]
      .map(([url, qs]) => ({ url, citedFor: [...qs].sort() }))
      .sort((a, b) => b.citedFor.length - a.citedFor.length)
    return {
      domain,
      citationCount: data.count,
      totalCount: total,
      pressureLabel,
      citedQueries: [...data.queries].sort(),
      sharePct,
      theirCitedPages,
    }
  })

  competitorRows.sort((a, b) => b.citationCount - a.citationCount)

  return { projectCitationCount, competitors: competitorRows }
}
