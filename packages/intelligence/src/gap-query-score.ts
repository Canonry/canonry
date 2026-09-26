import { CitationStates, percentOf, type ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { gapTone } from './score-tones.js'

export interface GapQueryScoreSnapshot {
  queryId: string
  citationState: string
  /** Tracked competitors present in source-list citation evidence. */
  citedCompetitorDomains: readonly string[]
  /** Tracked competitors present in answer prose. */
  mentionedCompetitorDomains: readonly string[]
  /** True when the project's brand/domain appears in the LLM answer text. */
  answerMentioned?: boolean | null
}

/**
 * Computes the "Gap Queries" score gauge — tracked queries where a competitor
 * is cited but the project is not. A query counts as a gap when:
 *   1. No snapshot for that query has citationState='cited' for the project
 *   2. At least one snapshot cites a tracked competitor in source evidence
 *
 * The gauge value is the gap count itself (so the dashboard reads the magnitude
 * directly), with `progress` set to the 0–100 percentage of tracked queries
 * that are gaps, to two decimals.
 */
export function buildGapQueryScore(
  snapshots: readonly GapQueryScoreSnapshot[],
): ScoreSummaryDto {
  const tooltip = 'Tracked queries where a competitor is cited in the latest run but your domain is not.'

  if (snapshots.length === 0) {
    return {
      label: 'Gap Queries',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'Run a visibility sweep to identify queries where competitors are cited and your domain is not.',
      tooltip,
      trend: [],
    }
  }

  const byQuery = new Map<string, { cited: boolean; citedCompetitors: Set<string> }>()
  for (const snap of snapshots) {
    const key = snap.queryId
    const current = byQuery.get(key) ?? { cited: false, citedCompetitors: new Set<string>() }
    if (snap.citationState === CitationStates.cited) current.cited = true
    for (const domain of snap.citedCompetitorDomains) current.citedCompetitors.add(domain)
    byQuery.set(key, current)
  }

  const totalCount = byQuery.size
  const gapCount = [...byQuery.values()].filter(
    entry => !entry.cited && entry.citedCompetitors.size > 0,
  ).length
  const gapQueryLabel = gapCount === 1 ? 'query' : 'queries'

  return {
    label: 'Citation Gaps',
    value: `${gapCount}`,
    delta: `${gapCount} of ${totalCount} queries at risk`,
    tone: gapTone(gapCount, totalCount),
    description: gapCount > 0
      ? `${gapCount} tracked ${gapQueryLabel} currently cite competitors without citing your domain.`
      : 'No competitive citation gaps detected in the latest visibility run.',
    tooltip,
    trend: [],
    progress: percentOf(gapCount, totalCount) ?? 0,
  }
}

/**
 * Mirror of {@link buildGapQueryScore} on the mention signal. A query counts
 * as a mention gap when:
 *   1. No snapshot for that query has `answerMentioned=true` (your brand /
 *      domain never appears in the LLM answer prose)
 *   2. At least one snapshot mentions a tracked competitor in answer prose
 *
 * Reported alongside the citation gap because per AGENTS.md the two signals
 * are independent — a query can be cited but not mentioned (citation card
 * but no brand acknowledgement in the prose) or vice versa.
 */
export function buildMentionGapScore(
  snapshots: readonly GapQueryScoreSnapshot[],
): ScoreSummaryDto {
  const tooltip = 'Tracked queries where a competitor surfaces in the latest run but your brand / domain is not mentioned in the answer text.'

  if (snapshots.length === 0) {
    return {
      label: 'Mention Gaps',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'Run a visibility sweep to identify queries where competitors are mentioned and your brand is not.',
      tooltip,
      trend: [],
    }
  }

  const byQuery = new Map<string, { mentioned: boolean; mentionedCompetitors: Set<string> }>()
  for (const snap of snapshots) {
    const key = snap.queryId
    const current = byQuery.get(key) ?? { mentioned: false, mentionedCompetitors: new Set<string>() }
    if (snap.answerMentioned === true) current.mentioned = true
    for (const domain of snap.mentionedCompetitorDomains) current.mentionedCompetitors.add(domain)
    byQuery.set(key, current)
  }

  const totalCount = byQuery.size
  const gapCount = [...byQuery.values()].filter(
    entry => !entry.mentioned && entry.mentionedCompetitors.size > 0,
  ).length
  const gapQueryLabel = gapCount === 1 ? 'query' : 'queries'

  return {
    label: 'Mention Gaps',
    value: `${gapCount}`,
    delta: `${gapCount} of ${totalCount} queries at risk`,
    tone: gapTone(gapCount, totalCount),
    description: gapCount > 0
      ? `${gapCount} tracked ${gapQueryLabel} mention competitors but never your brand.`
      : 'No competitive mention gaps detected in the latest visibility run.',
    tooltip,
    trend: [],
    progress: percentOf(gapCount, totalCount) ?? 0,
  }
}
