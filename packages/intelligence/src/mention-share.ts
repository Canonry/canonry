import type { MetricTone, ScoreSummaryDto } from '@ainyc/canonry-contracts'

export interface MentionShareSnapshot {
  /** True when the project's brand or domain appears in the LLM's answer text.
   *  Pre-computed by the provider extractors; we use it directly so the
   *  project-side definition stays in lockstep with `answerMentioned`. */
  projectMentioned: boolean
  /** Raw answer text for scanning competitor brand presence. May be empty
   *  for failed / pending snapshots — those are excluded from the universe. */
  answerText: string | null
}

export interface MentionShareCompetitor {
  /** Display name / registered domain — what the UI shows in the breakdown. */
  domain: string
  /** Brand tokens to look for in answer prose. Caller builds these via
   *  `brandLabelFromDomain` plus any operator-curated aliases. */
  brandTokens: readonly string[]
}

export interface MentionShareOptions {
  competitors: readonly MentionShareCompetitor[]
}

export interface MentionShareCompetitorRow {
  domain: string
  mentionSnapshots: number
  /** % of competitive total — sums to 100 across rows when there are any
   *  competitor mentions; 0 otherwise. */
  shareOfCompetitiveTotal: number
}

export interface MentionShareBreakdown {
  projectMentionSnapshots: number
  competitorMentionSnapshots: number
  perCompetitor: MentionShareCompetitorRow[]
  snapshotsWithAnswerText: number
  snapshotsTotal: number
}

export interface MentionShareResult extends ScoreSummaryDto {
  breakdown: MentionShareBreakdown
}

/**
 * Mention Share — the head-to-head competitive metric. Counts how often the
 * project's brand surfaces in answer text vs how often competitor brands do.
 *
 *   share = project_mention_snapshots
 *         / (project_mention_snapshots + competitor_mention_snapshots)
 *
 * Per-snapshot count (not per-occurrence): if the LLM names you three times
 * in one answer, that's still one snapshot. Mirrors the binary semantics of
 * `answerMentioned`.
 *
 * Strips out Wikipedia / news / unrelated sources entirely — answers your
 * question "when the LLM names a brand in its prose, how often is it you?"
 *
 * Returns neutral "Add competitors" when no competitors are configured —
 * the metric is undefined without a competitive frame, and reporting 100%
 * would mislead.
 */
export function buildMentionShare(
  snapshots: readonly MentionShareSnapshot[],
  options: MentionShareOptions,
): MentionShareResult {
  const tooltip = 'When AI answers your tracked queries and names a brand, the % of brand-name-drops that are you vs your tracked competitors. Cleaner than Citation Coverage for "am I winning the conversation".'
  const emptyBreakdown: MentionShareBreakdown = {
    projectMentionSnapshots: 0,
    competitorMentionSnapshots: 0,
    perCompetitor: [],
    snapshotsWithAnswerText: 0,
    snapshotsTotal: snapshots.length,
  }

  if (snapshots.length === 0) {
    return {
      label: 'Mention Share',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'No mention share data yet. Trigger a run to start tracking.',
      tooltip,
      trend: [],
      breakdown: emptyBreakdown,
    }
  }

  if (options.competitors.length === 0) {
    return {
      label: 'Mention Share',
      value: 'Add competitors',
      delta: 'No competitors configured',
      tone: 'neutral',
      description: 'Mention Share is a head-to-head competitive metric — add tracked competitors to compare brand mention rates.',
      tooltip,
      trend: [],
      breakdown: emptyBreakdown,
    }
  }

  let projectMentionSnapshots = 0
  let snapshotsWithAnswerText = 0
  const competitorCounts = new Map<string, number>()
  for (const c of options.competitors) competitorCounts.set(c.domain, 0)

  for (const snap of snapshots) {
    const text = snap.answerText ?? ''
    if (text.length === 0) continue
    snapshotsWithAnswerText++
    if (snap.projectMentioned) projectMentionSnapshots++
    for (const competitor of options.competitors) {
      if (competitorMentioned(text, competitor.brandTokens)) {
        competitorCounts.set(competitor.domain, (competitorCounts.get(competitor.domain) ?? 0) + 1)
      }
    }
  }

  const competitorMentionSnapshots = [...competitorCounts.values()].reduce((a, b) => a + b, 0)
  const denom = projectMentionSnapshots + competitorMentionSnapshots
  const score = denom > 0 ? Math.round((projectMentionSnapshots / denom) * 100) : 0

  const perCompetitor: MentionShareCompetitorRow[] = options.competitors
    .map(c => ({
      domain: c.domain,
      mentionSnapshots: competitorCounts.get(c.domain) ?? 0,
      shareOfCompetitiveTotal: competitorMentionSnapshots > 0
        ? Math.round(((competitorCounts.get(c.domain) ?? 0) / competitorMentionSnapshots) * 1000) / 10
        : 0,
    }))
    .filter(row => row.mentionSnapshots > 0)
    .sort((a, b) => b.mentionSnapshots - a.mentionSnapshots)

  const breakdown: MentionShareBreakdown = {
    projectMentionSnapshots,
    competitorMentionSnapshots,
    perCompetitor,
    snapshotsWithAnswerText,
    snapshotsTotal: snapshots.length,
  }

  const description = describe({
    score, projectMentionSnapshots, competitorMentionSnapshots, perCompetitor,
  })

  return {
    label: 'Mention Share',
    value: denom > 0 ? `${score}` : '0',
    delta: denom > 0
      ? `${projectMentionSnapshots} of ${denom} brand mentions`
      : 'No brand mentions in this run',
    tone: denom > 0 ? mentionShareTone(score) : 'neutral',
    description,
    tooltip,
    trend: [],
    progress: denom > 0 ? score : 0,
    breakdown,
  }
}

/**
 * Mention Share tone bands — looser than Citation Coverage because this is
 * already a competitive frame (other sources excluded).
 *
 *   ≥50% : positive — you win head-to-head more than half the time
 *   25-49%: caution — meaningful share but losing the head-to-head
 *   <25% : negative — competitors dominate the conversation
 */
function mentionShareTone(score: number): MetricTone {
  if (score >= 50) return 'positive'
  if (score >= 25) return 'caution'
  return 'negative'
}

function competitorMentioned(text: string, brandTokens: readonly string[]): boolean {
  for (const token of brandTokens) {
    if (token.length < 3) continue
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`, 'i')
    if (re.test(text)) return true
  }
  return false
}

function describe(parts: {
  score: number
  projectMentionSnapshots: number
  competitorMentionSnapshots: number
  perCompetitor: readonly MentionShareCompetitorRow[]
}): string {
  const { score, projectMentionSnapshots, competitorMentionSnapshots, perCompetitor } = parts
  if (projectMentionSnapshots === 0 && competitorMentionSnapshots === 0) {
    return 'No brand mentions detected for you or your tracked competitors in this run.'
  }
  if (competitorMentionSnapshots === 0) {
    return `${projectMentionSnapshots} brand mentions of you, zero competitor mentions — you own the conversation.`
  }
  const top = perCompetitor[0]
  if (!top) {
    return `${score}% of brand mentions are you (${projectMentionSnapshots} of ${projectMentionSnapshots + competitorMentionSnapshots}).`
  }
  return `${score}% of brand mentions are you. Top competitor: ${top.domain} (${top.mentionSnapshots} mentions).`
}
