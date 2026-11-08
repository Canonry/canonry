import { RunKinds, RunStatuses, RunTriggers } from './run.js'
import type { AttentionItemDto, MetricTone, ProjectOverviewWhatChangedDto } from './composites.js'

/**
 * A row of Overview's "What changed". A project's own rows have a
 * destination; the portfolio's status rows have none.
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

/** The project fields a What changed row names and links. A missing display name falls back to the name. */
export interface WhatChangedProject {
  id: string
  name: string
  displayName?: string
}

function projectLabel(project: WhatChangedProject): string {
  return project.displayName || project.name
}

/** A queued or running AI Visibility sweep is in progress; a probe never is. */
export function isWhatChangedActiveRun(run: { kind: string; status: string; trigger: string }): boolean {
  return run.kind === RunKinds['answer-visibility']
    && (run.status === RunStatuses.queued || run.status === RunStatuses.running)
    && run.trigger !== RunTriggers.probe
}

function queryCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'query' : 'queries'}`
}

/**
 * One project's What changed rows in the order Overview lists them: lost
 * mentions, then lost citations (the two signals are counted apart), then
 * runs in progress. The server fills `whatChanged.items` with these, and the
 * dashboard builds the same rows with its fresher count of runs in progress.
 */
export function whatChangedProjectItems(
  project: WhatChangedProject,
  counts: { lostMentionQueries: number; lostCitationQueries: number; activeRuns: number },
): AttentionItemDto[] {
  const label = projectLabel(project)
  const projectHref = `/projects/${encodeURIComponent(project.name)}`
  const items: AttentionItemDto[] = []
  if (counts.lostMentionQueries > 0) {
    items.push({
      id: `attention_${project.id}_lost_mentions`,
      tone: 'negative',
      title: `${label} lost mentions`,
      detail: `${queryCountLabel(counts.lostMentionQueries)} lost a mention in the latest check.`,
      actionLabel: 'Open project',
      href: projectHref,
    })
  }
  if (counts.lostCitationQueries > 0) {
    items.push({
      id: `attention_${project.id}_lost`,
      tone: 'negative',
      title: `${label} lost citations`,
      detail: `${queryCountLabel(counts.lostCitationQueries)} lost a citation in the latest check.`,
      actionLabel: 'Open project',
      href: projectHref,
    })
  }
  if (counts.activeRuns > 0) {
    items.push({
      id: `attention_${project.id}_active`,
      tone: 'neutral',
      title: `${label} has active runs`,
      detail: `${counts.activeRuns} ${counts.activeRuns === 1 ? 'run' : 'runs'} in progress.`,
      actionLabel: 'View runs',
      href: '/runs',
    })
  }
  return items
}

/** Names the projects whose overview could not be read, so nothing claims they are clear. */
function unreadItem(labels: readonly string[]): PortfolioWhatChangedItem {
  const one = labels.length === 1
  return {
    id: 'attention_unread',
    tone: 'caution',
    title: `${labels.length} ${one ? 'project' : 'projects'} couldn't be loaded`,
    detail: `${labels.join(', ')}. ${one ? 'Its' : 'Their'} lost mentions and citations are unknown.`,
  }
}

export interface PortfolioWhatChangedEntry {
  project: WhatChangedProject
  /** Null when the project's overview could not be read: its changes are unknown. */
  whatChanged: ProjectOverviewWhatChangedDto | null
  /**
   * Runs in progress from a fresher source than the overview, such as the
   * dashboard's polled run list. Omitted, the overview's own count is used.
   */
  activeRuns?: number
}

/**
 * Overview's "What changed" across projects: every project's rows, in the
 * order the projects are given, then one row naming any project whose
 * overview could not be read. Only when every project was read and none has a
 * row does one status row stand in: all clear once any project has a
 * completed check, awaiting the first measurement before that.
 *
 * Shared by the dashboard and `canonry overview --all`, so both list the same rows.
 */
export function portfolioWhatChangedItems(entries: readonly PortfolioWhatChangedEntry[]): PortfolioWhatChangedItem[] {
  if (entries.length === 0) return []
  const items: PortfolioWhatChangedItem[] = entries.flatMap(({ project, whatChanged, activeRuns }) => whatChangedProjectItems(project, {
    lostMentionQueries: whatChanged?.lostMentions.queryCount ?? 0,
    lostCitationQueries: whatChanged?.lostCitations.queryCount ?? 0,
    activeRuns: activeRuns ?? whatChanged?.activeRuns.count ?? 0,
  }))
  const unread = entries.filter(entry => entry.whatChanged === null).map(entry => projectLabel(entry.project))
  if (unread.length > 0) return [...items, unreadItem(unread)]
  if (items.length > 0) return items
  return [entries.some(entry => entry.whatChanged?.latestCheck) ? { ...ALL_CLEAR_ITEM } : { ...AWAITING_ITEM }]
}
