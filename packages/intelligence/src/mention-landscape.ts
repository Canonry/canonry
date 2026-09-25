import {
  brandKeyFromText,
  brandLabelFromDomain,
  compileQueryClassifier,
  determineAnswerMentioned,
  MIN_DOMAIN_BRAND_KEY_LENGTH,
  percentOf,
  type MentionRow,
  type ProjectReportDto,
  type QueryClass,
} from '@ainyc/canonry-contracts'

export interface MentionLandscapeSnapshot {
  queryId: string
  answerText: string | null
  answerMentioned: boolean | null
}

export interface MentionLandscapeQueryLookup {
  byId: Map<string, string>
}

type LandscapeSection = ProjectReportDto['mentionLandscape']['nonBrand']

interface SectionTally {
  projectMentionCount: number
  totalAnswerSnapshots: number
  competitorMap: Map<string, { count: number; queries: Set<string> }>
}

function emptySection(competitorDomains: readonly string[]): SectionTally {
  return {
    projectMentionCount: 0,
    totalAnswerSnapshots: 0,
    competitorMap: new Map(competitorDomains.map(c => [c, { count: 0, queries: new Set<string>() }])),
  }
}

function toSection(tally: SectionTally): LandscapeSection {
  const totalMentionedSlots = tally.projectMentionCount
    + [...tally.competitorMap.values()].reduce((sum, v) => sum + v.count, 0)

  const competitorRows: MentionRow[] = [...tally.competitorMap.entries()].map(([domain, data]) => {
    const ratio = tally.totalAnswerSnapshots > 0 ? data.count / tally.totalAnswerSnapshots : 0
    let pressureLabel: MentionRow['pressureLabel'] = 'None'
    if (data.count > 0) {
      if (ratio >= 0.5) pressureLabel = 'High'
      else if (ratio >= 0.2) pressureLabel = 'Moderate'
      else pressureLabel = 'Low'
    }
    const sharePct = percentOf(data.count, totalMentionedSlots)
    return {
      domain,
      mentionCount: data.count,
      totalCount: tally.totalAnswerSnapshots,
      pressureLabel,
      mentionedQueries: [...data.queries].sort(),
      sharePct,
    }
  })

  competitorRows.sort((a, b) => b.mentionCount - a.mentionCount)

  return {
    projectMentionCount: tally.projectMentionCount,
    totalAnswerSnapshots: tally.totalAnswerSnapshots,
    competitors: competitorRows,
  }
}

/**
 * Who the model names in its prose, split by query class.
 *
 * The top-level fields stay the NON-BRAND view because that is the competitive
 * question the report asks ("in my category, who does AI name?"). A branded
 * query hands the model the project's name, so the project is named on nearly
 * all of them and a tracked competitor structurally cannot be — pooling the two
 * lets branded recall outvote the category and flips the ranking the chart
 * exists to show. `branded` carries the recognition view beside it.
 */
export function buildMentionLandscape(
  snapshots: readonly MentionLandscapeSnapshot[],
  competitorDomains: readonly string[],
  projectBrandNames: readonly string[],
  projectDomains: readonly string[],
  queryLookup: MentionLandscapeQueryLookup,
): ProjectReportDto['mentionLandscape'] {
  const classifier = compileQueryClassifier(projectBrandNames)
  const nonBrand = emptySection(competitorDomains)
  const branded = emptySection(competitorDomains)
  const unclassified = emptySection(competitorDomains)

  // Answer-text brand matching is what a mention IS. The stored, run-time
  // `competitor_overlap` column is legacy MIXED evidence (answer mentions plus
  // cited/grounding hosts) and is deliberately not read here — deriving a
  // mention count from it would report one signal under the other's name.
  const competitorAliases = new Map<string, string[]>(
    competitorDomains.map(domain => {
      const label = brandLabelFromDomain(domain)
      return [domain, brandKeyFromText(label).length >= MIN_DOMAIN_BRAND_KEY_LENGTH ? [label] : []]
    }),
  )

  for (const snap of snapshots) {
    const text = snap.answerText
    if (!text) continue

    const q = queryLookup.byId.get(snap.queryId)
    const queryClass: QueryClass | null = classifier ? classifier.classify(q ?? null) : null
    const tally = queryClass === 'branded' ? branded : queryClass === 'non-brand' ? nonBrand : unclassified
    tally.totalAnswerSnapshots++

    // The report uses the current project identity. A persisted boolean may be
    // stale after an alias/domain rename; answer text is the source of truth.
    const projectMentioned = determineAnswerMentioned(
      text,
      [...projectBrandNames],
      [...projectDomains],
    )
    if (projectMentioned) tally.projectMentionCount++

    for (const competitor of competitorDomains) {
      const aliases = competitorAliases.get(competitor) ?? []
      const mentioned = determineAnswerMentioned(text, aliases, [competitor])
      if (mentioned) {
        const entry = tally.competitorMap.get(competitor)!
        entry.count++
        if (q) entry.queries.add(q)
      }
    }
  }

  // Scope describes classifier availability, not whether this particular
  // window happened to contain an answer. An empty classifiable report remains
  // non-brand; pooled is reserved for projects with no usable identity.
  const scope = classifier ? 'non-brand' as const : 'pooled' as const
  const headline = toSection(scope === 'non-brand' ? nonBrand : unclassified)

  return {
    // Kept at the top level so every existing reader of `projectMentionCount` /
    // `competitors` gets the competitive figure rather than the pooled one.
    ...headline,
    scope,
    nonBrand: headline,
    branded: toSection(branded),
  }
}
