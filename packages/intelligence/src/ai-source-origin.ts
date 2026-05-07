import {
  categorizeSourceWithCompetitors,
  categoryLabel,
  type AiSourceCategoryBucket,
  type ProjectReportDto,
  type SourceCategory,
} from '@ainyc/canonry-contracts'
import { citedDomainBelongsToProject } from './domain-matching.js'

export interface AiSourceOriginSnapshot {
  citedDomains: string[]
}

export const DEFAULT_TOP_SOURCE_DOMAINS_LIMIT = 20

export function buildAiSourceOrigin(
  snapshots: readonly AiSourceOriginSnapshot[],
  projectDomains: readonly string[],
  competitorDomains: readonly string[],
  topDomainsLimit: number = DEFAULT_TOP_SOURCE_DOMAINS_LIMIT,
): ProjectReportDto['aiSourceOrigin'] {
  const categoryCounts = new Map<string, { label: string; count: number }>()
  const domainCounts = new Map<string, number>()
  let totalCitations = 0

  for (const snap of snapshots) {
    for (const raw of snap.citedDomains) {
      if (citedDomainBelongsToProject(raw, projectDomains)) continue
      // Tracked competitors take priority over rule-based bucketing — readers
      // care more about "X% of AI sources are tracked rivals" than which
      // generic category each rival happens to fall into.
      const { category, domain } = categorizeSourceWithCompetitors(
        raw,
        competitorDomains,
        citedDomainBelongsToProject,
      )
      // Use the category's standard label, not the per-domain rule label —
      // a forum bucket should read "Forums & Q&A", not whichever of
      // Reddit/Quora/Stack Exchange happened to be matched first.
      const bucketLabel = categoryLabel(category as SourceCategory)
      const cat = categoryCounts.get(category) ?? { label: bucketLabel, count: 0 }
      cat.count++
      categoryCounts.set(category, cat)
      domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1)
      totalCitations++
    }
  }

  const categories: AiSourceCategoryBucket[] = [...categoryCounts.entries()]
    .map(([category, { label, count }]) => ({
      category,
      label,
      count,
      sharePct: totalCitations > 0 ? Math.round((count / totalCitations) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count)

  const topDomains = [...domainCounts.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      isCompetitor: citedDomainBelongsToProject(domain, competitorDomains),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topDomainsLimit)

  return { categories, topDomains }
}
