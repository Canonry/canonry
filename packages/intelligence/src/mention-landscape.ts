import {
  brandLabelFromDomain,
  determineAnswerMentioned,
  type MentionRow,
  type ProjectReportDto,
} from '@ainyc/canonry-contracts'

export interface MentionLandscapeSnapshot {
  queryId: string
  answerText: string | null
  answerMentioned: boolean | null
}

export interface MentionLandscapeQueryLookup {
  byId: Map<string, string>
}

export function buildMentionLandscape(
  snapshots: readonly MentionLandscapeSnapshot[],
  competitorDomains: readonly string[],
  projectDisplayName: string,
  projectDomains: readonly string[],
  queryLookup: MentionLandscapeQueryLookup,
): ProjectReportDto['mentionLandscape'] {
  let projectMentionCount = 0
  let totalAnswerSnapshots = 0
  const competitorMap = new Map<string, { count: number; queries: Set<string> }>()
  for (const c of competitorDomains) {
    competitorMap.set(c, { count: 0, queries: new Set() })
  }

  for (const snap of snapshots) {
    const text = snap.answerText
    if (!text) continue
    totalAnswerSnapshots++

    const q = queryLookup.byId.get(snap.queryId)
    // Prefer the run-time computed answerMentioned (against project's own brand
    // + domains). Fall back to a recompute when the column is null (legacy rows).
    const projectMentioned = snap.answerMentioned ?? determineAnswerMentioned(
      text,
      projectDisplayName,
      [...projectDomains],
    )
    if (projectMentioned) projectMentionCount++

    for (const competitor of competitorDomains) {
      const brand = brandLabelFromDomain(competitor)
      const mentioned = determineAnswerMentioned(text, brand, [competitor])
      if (mentioned) {
        const entry = competitorMap.get(competitor)!
        entry.count++
        if (q) entry.queries.add(q)
      }
    }
  }

  const totalMentionedSlots = projectMentionCount
    + [...competitorMap.values()].reduce((sum, v) => sum + v.count, 0)

  const competitorRows: MentionRow[] = [...competitorMap.entries()].map(([domain, data]) => {
    const ratio = totalAnswerSnapshots > 0 ? data.count / totalAnswerSnapshots : 0
    let pressureLabel: MentionRow['pressureLabel'] = 'None'
    if (data.count > 0) {
      if (ratio >= 0.5) pressureLabel = 'High'
      else if (ratio >= 0.2) pressureLabel = 'Moderate'
      else pressureLabel = 'Low'
    }
    const sharePct = totalMentionedSlots > 0
      ? Math.round((data.count / totalMentionedSlots) * 100)
      : 0
    return {
      domain,
      mentionCount: data.count,
      totalCount: totalAnswerSnapshots,
      pressureLabel,
      mentionedQueries: [...data.queries].sort(),
      sharePct,
    }
  })

  competitorRows.sort((a, b) => b.mentionCount - a.mentionCount)

  return { projectMentionCount, totalAnswerSnapshots, competitors: competitorRows }
}
