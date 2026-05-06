import type { CompetitorRow, GroundingSource, ProjectReportDto } from '@ainyc/canonry-contracts'
import { citedDomainBelongsToProject } from './domain-matching.js'

export interface CompetitorLandscapeSnapshot {
  queryId: string
  citedDomains: string[]
  competitorOverlap: string[]
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

  for (const snap of snapshots) {
    const q = queryLookup.byId.get(snap.queryId)
    const allDomains = [...snap.citedDomains, ...snap.competitorOverlap]
    if (allDomains.some(d => citedDomainBelongsToProject(d, projectDomains))) {
      projectCitationCount++
    }

    for (const competitor of competitorDomains) {
      if (allDomains.some(d => citedDomainBelongsToProject(d, [competitor]))) {
        const entry = competitorMap.get(competitor)!
        entry.count++
        if (q) entry.queries.add(q)
      }
      const competitorNorm = normalizeUrlDomain(competitor)
      for (const gs of snap.groundingSources) {
        const host = normalizeUrlDomain(extractHostFromUri(gs.uri))
        if (!host) continue
        if (host === competitorNorm || host.endsWith(`.${competitorNorm}`)) {
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
    const sharePct = totalCitedSlots > 0
      ? Math.round((data.count / totalCitedSlots) * 100)
      : 0
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

function normalizeUrlDomain(domain: string): string {
  return domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
}

function extractHostFromUri(uri: string): string {
  try {
    return new URL(uri).hostname
  } catch {
    return ''
  }
}
