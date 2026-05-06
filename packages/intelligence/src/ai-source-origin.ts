import {
  categorizeSource,
  type AiSourceCategoryBucket,
  type ProjectReportDto,
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
      const { category, label, domain } = categorizeSource(raw)
      const cat = categoryCounts.get(category) ?? { label, count: 0 }
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
