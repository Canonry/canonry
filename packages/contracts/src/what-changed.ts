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
export const WHAT_CHANGED_ALL_CLEAR_DETAIL = 'No mentions or citations changed, and no runs in progress.'

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

/** The query counts behind one project's What changed rows. */
export interface WhatChangedCounts {
  lostMentionQueries: number
  gainedMentionQueries: number
  lostCitationQueries: number
  gainedCitationQueries: number
  activeRuns: number
}

/**
 * One signal's row: losses alone keep the row they always had, gains alone
 * get a positive row, and both share one row whose tone follows the larger
 * count (neutral on a tie). A query can lose on one answer and gain on
 * another, so it can count on both sides.
 */
function signalItem(
  project: WhatChangedProject,
  signal: { noun: 'mention' | 'citation'; lostId: string; gainedId: string; changedId: string },
  lost: number,
  gained: number,
): AttentionItemDto | null {
  if (lost === 0 && gained === 0) return null
  const label = projectLabel(project)
  const plural = `${signal.noun}s`
  const base = { actionLabel: 'Open project', href: `/projects/${encodeURIComponent(project.name)}` }
  if (gained === 0) {
    return { ...base, id: signal.lostId, tone: 'negative', title: `${label} lost ${plural}`, detail: `${queryCountLabel(lost)} lost a ${signal.noun} in the latest check.` }
  }
  if (lost === 0) {
    return { ...base, id: signal.gainedId, tone: 'positive', title: `${label} gained ${plural}`, detail: `${queryCountLabel(gained)} gained a ${signal.noun} in the latest check.` }
  }
  return {
    ...base,
    id: signal.changedId,
    tone: lost > gained ? 'negative' : gained > lost ? 'positive' : 'neutral',
    title: `${label} ${plural} changed`,
    detail: `${queryCountLabel(lost)} lost a ${signal.noun} and ${gained} gained one in the latest check.`,
  }
}

/**
 * One project's What changed rows in the order Overview lists them: mentions,
 * then citations (the two signals are counted apart), then runs in progress.
 * The server fills `whatChanged.items` with these, and the dashboard builds
 * the same rows with its fresher count of runs in progress.
 */
export function whatChangedProjectItems(project: WhatChangedProject, counts: WhatChangedCounts): AttentionItemDto[] {
  const label = projectLabel(project)
  const items: AttentionItemDto[] = []
  const mentions = signalItem(project, {
    noun: 'mention',
    lostId: `attention_${project.id}_lost_mentions`,
    gainedId: `attention_${project.id}_gained_mentions`,
    changedId: `attention_${project.id}_mentions_changed`,
  }, counts.lostMentionQueries, counts.gainedMentionQueries)
  if (mentions) items.push(mentions)
  const citations = signalItem(project, {
    noun: 'citation',
    lostId: `attention_${project.id}_lost`,
    gainedId: `attention_${project.id}_gained_citations`,
    changedId: `attention_${project.id}_citations_changed`,
  }, counts.lostCitationQueries, counts.gainedCitationQueries)
  if (citations) items.push(citations)
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
    detail: `${labels.join(', ')}. ${one ? 'Its' : 'Their'} changes are unknown.`,
  }
}

/** Names the projects compared with their previous check that changed on neither signal, so quiet reads as quiet. */
function unchangedItem(labels: readonly string[]): PortfolioWhatChangedItem {
  const one = labels.length === 1
  return {
    id: 'attention_unchanged',
    tone: 'neutral',
    title: `${labels.length} ${one ? 'project' : 'projects'} unchanged`,
    detail: `${labels.join(', ')}. No mentions or citations changed since the previous check.`,
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

/** A project's counts from its overview; a server before 7.123.0 reports no gains. */
function entryCounts({ whatChanged, activeRuns }: PortfolioWhatChangedEntry): WhatChangedCounts {
  return {
    lostMentionQueries: whatChanged?.lostMentions.queryCount ?? 0,
    gainedMentionQueries: whatChanged?.gainedMentions?.queryCount ?? 0,
    lostCitationQueries: whatChanged?.lostCitations.queryCount ?? 0,
    gainedCitationQueries: whatChanged?.gainedCitations?.queryCount ?? 0,
    activeRuns: activeRuns ?? whatChanged?.activeRuns.count ?? 0,
  }
}

/**
 * Overview's "What changed" across projects: every project's rows, in the
 * order the projects are given, then one row naming the projects that were
 * compared with their previous check and did not change, then one naming any
 * project whose overview could not be read. Only when every project was read
 * and none has a row does one status row stand in: all clear once any project
 * has a completed check, awaiting the first measurement before that.
 *
 * Shared by the dashboard and `canonry overview --all`, so both list the same rows.
 */
export function portfolioWhatChangedItems(entries: readonly PortfolioWhatChangedEntry[]): PortfolioWhatChangedItem[] {
  if (entries.length === 0) return []
  const counted = entries.map(entry => ({ entry, counts: entryCounts(entry) }))
  const items: PortfolioWhatChangedItem[] = counted.flatMap(({ entry, counts }) => whatChangedProjectItems(entry.project, counts))
  const unread = entries.filter(entry => entry.whatChanged === null).map(entry => projectLabel(entry.project))
  if (items.length === 0 && unread.length === 0) {
    return [entries.some(entry => entry.whatChanged?.latestCheck) ? { ...ALL_CLEAR_ITEM } : { ...AWAITING_ITEM }]
  }
  // Only a project actually compared can be called unchanged: one with no
  // previous check, or one compared under another definition, says nothing.
  const unchanged = counted
    .filter(({ entry, counts }) => entry.whatChanged?.comparison.state === 'available'
      && counts.lostMentionQueries + counts.gainedMentionQueries + counts.lostCitationQueries + counts.gainedCitationQueries + counts.activeRuns === 0)
    .map(({ entry }) => projectLabel(entry.project))
  return [
    ...items,
    ...(unchanged.length > 0 ? [unchangedItem(unchanged)] : []),
    ...(unread.length > 0 ? [unreadItem(unread)] : []),
  ]
}
