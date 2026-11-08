import type { MetricTone, ProjectOverviewWhatChangedDto } from './composites.js'

/**
 * A row of Overview's "What changed". A project's own rows come from the
 * server with a destination; the portfolio fallback rows have none.
 */
export interface PortfolioWhatChangedItem {
  id: string
  tone: MetricTone
  title: string
  detail: string
  actionLabel?: string
  href?: string
}

/** What a measured project with nothing to flag says, alone or across the portfolio. */
export const WHAT_CHANGED_ALL_CLEAR_DETAIL = 'No lost mentions or citations, and no runs in progress.'

const ALL_CLEAR_ITEM: PortfolioWhatChangedItem = {
  id: 'attention_stable',
  tone: 'positive',
  title: 'All projects stable',
  detail: WHAT_CHANGED_ALL_CLEAR_DETAIL,
}

const AWAITING_ITEM: PortfolioWhatChangedItem = {
  id: 'attention_awaiting',
  tone: 'neutral',
  title: 'Awaiting first measurement',
  detail: 'Visibility results will appear after the first check.',
}

/**
 * Overview's "What changed" across projects: every project's own rows, in the
 * order the projects are given. When no project has a row, one fallback row
 * says whether anything has been checked: all clear once any project has a
 * completed check, awaiting the first measurement before that. A project whose
 * overview could not be read is `null`: it has no rows and no check.
 *
 * Shared by the dashboard and `canonry overview --all`, so both list the same rows.
 */
export function portfolioWhatChangedItems(
  projects: ReadonlyArray<ProjectOverviewWhatChangedDto | null>,
): PortfolioWhatChangedItem[] {
  if (projects.length === 0) return []
  const items: PortfolioWhatChangedItem[] = projects.flatMap(project => project?.items ?? [])
  if (items.length > 0) return items
  return [projects.some(project => project?.latestCheck) ? { ...ALL_CLEAR_ITEM } : { ...AWAITING_ITEM }]
}
