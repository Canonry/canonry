import {
  formatRunErrorOneLine,
  PortfolioChangeTypes,
  type AttentionItemDto,
  type MetricTone,
  type MovementComparisonDto,
  type MovementSummaryDto,
  type PortfolioChangeDto,
  type PortfolioFeedEmptyStateDto,
  type RunErrorDto,
  type RunStatus,
} from '@ainyc/canonry-contracts'
import { RunStatuses } from '@ainyc/canonry-contracts'

/** Display cap for the portfolio change feed. `changeFeedTotal` reports the
 *  count before truncation so the UI can render "showing 12 of N". */
export const PORTFOLIO_CHANGE_FEED_LIMIT = 12

/** The latest answer-visibility run for one project, as the change feed needs
 *  it. `null` when the project has never had a (non-probe) visibility run. */
export interface PortfolioChangeFeedRunInput {
  runId: string
  status: RunStatus
  /** finishedAt ?? createdAt — the ordering anchor for run/movement rows. */
  occurredAt: string
  error: RunErrorDto | null
}

/** Per-project inputs for the change feed. Every field is already computed by
 *  the per-project overview assembly — this builder only reshapes them into a
 *  cross-project, ordered, copy-built stream. It performs NO movement math. */
export interface PortfolioChangeFeedProjectInput {
  /** Display name for copy. */
  projectName: string
  /** URL slug (project.name) used for hrefs and stable ids. */
  projectSlug: string
  /** Per-query citation gains/losses vs the previous comparable sweep. */
  citationMovement: MovementSummaryDto
  /** Per-query answer-mention gains/losses vs the previous comparable sweep. */
  mentionMovement: MovementSummaryDto
  /** Comparability + query-basket churn metadata for both movement fields. */
  movementComparison: MovementComparisonDto
  /** Server attention items: insight echoes (id `insight_*`) + `stale_visibility`. */
  attentionItems: readonly AttentionItemDto[]
  /** Latest answer-visibility run, or null when the project never ran one. */
  latestRun: PortfolioChangeFeedRunInput | null
  /** Tracked-query count for the never-run onboarding copy. */
  trackedQueryCount: number
  /** project.createdAt — ordering anchor for the never-run row. */
  projectCreatedAt: string
}

export interface PortfolioChangeFeedResult {
  changeFeed: PortfolioChangeDto[]
  /** Count before the display cap. */
  changeFeedTotal: number
  /** Non-null only when `changeFeed` is empty. */
  feedEmptyState: PortfolioFeedEmptyStateDto | null
  comparableProjectCount: number
  firstSweepProjectCount: number
}

// Within a single sweep's timestamp, surface the most actionable rows first.
// Losses (negative) before warnings (caution) before gains (positive) before
// neutral activity. Recency is the primary sort; this only breaks ties.
const TONE_SEVERITY: Record<MetricTone, number> = {
  negative: 0,
  caution: 1,
  positive: 2,
  neutral: 3,
}

function pluralizeQueries(n: number): string {
  return n === 1 ? 'query' : 'queries'
}

function pluralizeAnswers(n: number): string {
  return n === 1 ? 'answer' : 'answers'
}

/** First up-to-`max` affected queries, quoted, with a "+N more" tail. Empty
 *  string when the builder had no query-text lookup (queries arrays absent). */
function affectedDetail(queries: readonly string[] | undefined, max = 3): string {
  const list = queries ?? []
  if (list.length === 0) return ''
  const shown = list.slice(0, max).map(q => `"${q}"`).join(', ')
  const remaining = list.length - max
  return remaining > 0 ? `${shown} +${remaining} more` : shown
}

/** Emit the change rows for one project. Each project emits zero or more rows;
 *  the comparability gate ensures cohort churn is never shown as a gain/loss. */
function buildProjectChanges(input: PortfolioChangeFeedProjectInput): PortfolioChangeDto[] {
  const {
    projectName,
    projectSlug,
    citationMovement,
    mentionMovement,
    movementComparison,
    attentionItems,
    latestRun,
  } = input
  const href = `/projects/${encodeURIComponent(projectSlug)}`
  const rows: PortfolioChangeDto[] = []

  // A project with no visibility run is onboarding, not a delta.
  if (!latestRun) {
    rows.push({
      id: `${projectSlug}:${PortfolioChangeTypes['project-never-run']}`,
      projectName,
      projectSlug,
      changeType: PortfolioChangeTypes['project-never-run'],
      tone: 'neutral',
      title: `${projectName} has no completed sweep yet`,
      detail: `${input.trackedQueryCount} ${pluralizeQueries(input.trackedQueryCount)} tracked — run a sweep to start measuring.`,
      occurredAt: input.projectCreatedAt,
      href,
      actionLabel: 'Run sweep',
      comparable: false,
    })
    return rows
  }

  const { runId, occurredAt } = latestRun
  const comparable = movementComparison.comparable

  // A failed sweep is an attention event (also shown in recentRuns, but a
  // failure earns feed prominence).
  if (latestRun.status === RunStatuses.failed) {
    rows.push({
      id: `${projectSlug}:${PortfolioChangeTypes['run-failed']}:${runId}`,
      projectName,
      projectSlug,
      changeType: PortfolioChangeTypes['run-failed'],
      tone: 'negative',
      title: `${projectName} sweep failed`,
      detail: latestRun.error ? formatRunErrorOneLine(latestRun.error) : 'The latest visibility sweep failed.',
      occurredAt,
      href,
      actionLabel: 'View run',
      comparable,
    })
  }

  // Movement rows fire ONLY when the basket is comparable — otherwise the
  // counts (over the intersection) would mislead. citation-* reads only
  // citationMovement; mention-* reads only mentionMovement. Never crossed.
  if (comparable) {
    if (citationMovement.lost > 0) {
      rows.push({
        id: `${projectSlug}:${PortfolioChangeTypes['citation-lost']}:${runId}`,
        projectName,
        projectSlug,
        changeType: PortfolioChangeTypes['citation-lost'],
        tone: 'negative',
        title: `${projectName} lost ${citationMovement.lost} cited ${pluralizeQueries(citationMovement.lost)}`,
        detail: affectedDetail(citationMovement.lostQueries),
        occurredAt,
        href,
        actionLabel: 'Open project',
        comparable: true,
      })
    }
    if (citationMovement.gained > 0) {
      rows.push({
        id: `${projectSlug}:${PortfolioChangeTypes['citation-gained']}:${runId}`,
        projectName,
        projectSlug,
        changeType: PortfolioChangeTypes['citation-gained'],
        tone: 'positive',
        title: `${projectName} gained ${citationMovement.gained} cited ${pluralizeQueries(citationMovement.gained)}`,
        detail: affectedDetail(citationMovement.gainedQueries),
        occurredAt,
        href,
        actionLabel: 'Open project',
        comparable: true,
      })
    }
    if (mentionMovement.lost > 0) {
      const queries = affectedDetail(mentionMovement.lostQueries)
      rows.push({
        id: `${projectSlug}:${PortfolioChangeTypes['mention-lost']}:${runId}`,
        projectName,
        projectSlug,
        changeType: PortfolioChangeTypes['mention-lost'],
        tone: 'negative',
        title: `${projectName} dropped from ${mentionMovement.lost} ${pluralizeAnswers(mentionMovement.lost)}`,
        detail: queries ? `No longer mentioned for ${queries}` : '',
        occurredAt,
        href,
        actionLabel: 'Open project',
        comparable: true,
      })
    }
    if (mentionMovement.gained > 0) {
      rows.push({
        id: `${projectSlug}:${PortfolioChangeTypes['mention-gained']}:${runId}`,
        projectName,
        projectSlug,
        changeType: PortfolioChangeTypes['mention-gained'],
        tone: 'positive',
        title: `${projectName} now mentioned in ${mentionMovement.gained} more ${pluralizeAnswers(mentionMovement.gained)}`,
        detail: affectedDetail(mentionMovement.gainedQueries),
        occurredAt,
        href,
        actionLabel: 'Open project',
        comparable: true,
      })
    }
  } else if (movementComparison.hasPreviousRun && movementComparison.querySetChanged) {
    // Not comparable, but the basket changed — surface the churn as activity
    // (NEVER as a gain/loss) so the operator sees the project moved.
    rows.push({
      id: `${projectSlug}:${PortfolioChangeTypes['query-set-changed']}:${runId}`,
      projectName,
      projectSlug,
      changeType: PortfolioChangeTypes['query-set-changed'],
      tone: 'neutral',
      title: `${projectName} query set changed`,
      detail: `+${movementComparison.addedQueryCount} added · −${movementComparison.removedQueryCount} removed since last sweep — movement compares the shared queries`,
      occurredAt,
      href,
      actionLabel: 'Open project',
      comparable: false,
    })
  }

  // Server attention items → critical/high insight echoes + stale-visibility.
  // Anchored to the latest sweep time (the AttentionItemDto carries no
  // timestamp of its own); recency still orders by sweep, severity breaks ties.
  for (const item of attentionItems) {
    if (item.id.startsWith('insight_')) {
      const isCritical = item.tone === 'negative'
      const changeType = isCritical
        ? PortfolioChangeTypes['insight-critical']
        : PortfolioChangeTypes['insight-high']
      rows.push({
        id: `${projectSlug}:${changeType}:${item.id}`,
        projectName,
        projectSlug,
        changeType,
        tone: item.tone,
        title: item.title,
        detail: item.detail,
        occurredAt,
        href,
        actionLabel: isCritical ? 'Critical' : 'High',
        comparable,
      })
    } else if (item.id === 'stale_visibility') {
      rows.push({
        id: `${projectSlug}:${PortfolioChangeTypes['stale-visibility']}:${runId}`,
        projectName,
        projectSlug,
        changeType: PortfolioChangeTypes['stale-visibility'],
        tone: 'caution',
        title: `${projectName} visibility data is stale`,
        detail: 'Integration syncs have run since the last sweep.',
        occurredAt,
        href,
        actionLabel: 'Re-sweep',
        comparable,
      })
    }
  }

  return rows
}

function resolveEmptyState(
  projectCount: number,
  comparableProjectCount: number,
): PortfolioFeedEmptyStateDto {
  // No project has a second, comparable sweep yet — movement literally cannot
  // be computed. This is the honest replacement for the old "All projects
  // stable" lie that fired on single-run portfolios.
  if (comparableProjectCount === 0) {
    return {
      kind: 'awaiting-second-sweep',
      title: 'No changes to compare yet',
      detail: 'Visibility movement appears after a second sweep.',
    }
  }
  // Projects ran comparably and genuinely nothing moved — rendered neutral,
  // not celebratory, because it only means "no delta", not "all good".
  return {
    kind: 'all-clear',
    title: 'No changes since the last sweep',
    detail: `All ${projectCount} project${projectCount === 1 ? '' : 's'} held their mention and citation coverage.`,
  }
}

/**
 * Build the cross-project "what changed" feed from per-project overview
 * signals. Pure: takes already-computed movement/attention/run inputs and an
 * explicit `nowIso` anchor, returns an ordered, deduped, capped feed plus the
 * envelope counts and the (only-when-empty) honest empty state.
 *
 * Ordering: recency (occurredAt) descending first, so a fresh change never
 * sinks below an old one; within one sweep's timestamp, tone severity
 * (negative → caution → positive → neutral); then projectName, then id — fully
 * deterministic so the CLI JSON and the UI agree run to run.
 *
 * `nowIso` is currently reserved for forward-compatible relative-time
 * derivation; ordering uses the absolute `occurredAt` so the parameter keeps
 * the builder pure and clock-free.
 */
export function buildPortfolioChangeFeed(
  inputs: readonly PortfolioChangeFeedProjectInput[],
  _nowIso: string,
): PortfolioChangeFeedResult {
  const all: PortfolioChangeDto[] = []
  let comparableProjectCount = 0
  let firstSweepProjectCount = 0

  for (const input of inputs) {
    if (input.latestRun) {
      if (input.movementComparison.comparable) comparableProjectCount += 1
      if (!input.movementComparison.hasPreviousRun) firstSweepProjectCount += 1
    }
    all.push(...buildProjectChanges(input))
  }

  // Defensive dedup by stable id (one row per project × changeType × run).
  const byId = new Map<string, PortfolioChangeDto>()
  for (const row of all) {
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  const deduped = [...byId.values()]

  deduped.sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1
    const severity = TONE_SEVERITY[a.tone] - TONE_SEVERITY[b.tone]
    if (severity !== 0) return severity
    if (a.projectName !== b.projectName) return a.projectName < b.projectName ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const changeFeedTotal = deduped.length
  const changeFeed = deduped.slice(0, PORTFOLIO_CHANGE_FEED_LIMIT)
  const feedEmptyState =
    changeFeedTotal === 0 ? resolveEmptyState(inputs.length, comparableProjectCount) : null

  return {
    changeFeed,
    changeFeedTotal,
    feedEmptyState,
    comparableProjectCount,
    firstSweepProjectCount,
  }
}
