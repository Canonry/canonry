import {
  brandKeyFromText,
  compileBrandAliases,
  formatPercent,
  matcherMatchesText,
  percentOf,
  type BrandAliasMatcher,
  type MetricTone,
  type QueryClass,
  type ScoreSummaryDto,
} from '@ainyc/canonry-contracts'

/**
 * The shortest brand alias that may be matched in answer prose.
 *
 * Three, because real brands are three letters (`COS`, `IBM`) and the matcher
 * this feeds requires COMPLETE adjacent words — `cos` never matches inside
 * `cosmetics`, so length is not what protects against a false hit. The one
 * threshold lives here rather than at each call site: the same brand counted by
 * one surface and dropped by another is a silent disagreement about the same
 * answer, which is exactly the class of bug that made a stored citation-side
 * column and this metric report different mention counts for the same run.
 */
export const MIN_BRAND_ALIAS_KEY_LENGTH = 3

/** Aliases worth compiling — short/empty tokens would match noise, not identity. */
export function usableBrandAliases(aliases: readonly string[]): string[] {
  return aliases.filter(alias => brandKeyFromText(alias).length >= MIN_BRAND_ALIAS_KEY_LENGTH)
}

export interface MentionShareSnapshot {
  /** True when the project's brand or domain appears in the LLM's answer text.
   *  Pre-computed by the provider extractors; we use it directly so the
   *  project-side definition stays in lockstep with `answerMentioned`. */
  projectMentioned: boolean
  /** Raw answer text for scanning competitor brand presence. May be empty
   *  for failed / pending snapshots — those are excluded from the universe. */
  answerText: string | null
  /**
   * Which class the query behind this snapshot belongs to, or `null` when the
   * caller could not classify (no usable project brand alias). `null` is NOT
   * `non-brand`: an unclassifiable basket produces a pooled figure that is
   * labelled pooled, never a non-brand claim the data cannot support.
   */
  queryClass?: QueryClass | null
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
  /**
   * The project has a usable query classifier, even if this snapshot window is
   * empty. Without this hint an empty array cannot distinguish "no data" from
   * "no brand alias", and would incorrectly label a classifiable project as
   * pooled. Classified snapshots imply this automatically.
   */
  classificationAvailable?: boolean
}

export interface MentionShareCompetitorRow {
  domain: string
  mentionSnapshots: number
  /** % of competitive total, 0..100 to two decimals — sums to ~100 across
   *  rows when there are any competitor mentions; 0 otherwise. */
  shareOfCompetitiveTotal: number
}

export interface MentionShareBreakdown {
  projectMentionSnapshots: number
  competitorMentionSnapshots: number
  perCompetitor: MentionShareCompetitorRow[]
  snapshotsWithAnswerText: number
  snapshotsTotal: number
  /**
   * `projectMentionSnapshots / (project + competitor)` as 0..100 to two
   * decimals, or `null` when nothing in this class was mentioned at all. Null
   * rather than 0 because "no brand was named" is not "you lost every naming".
   */
  score: number | null
}

/** What the headline and `breakdown` describe. Never a pooled figure under a non-brand name. */
export type MentionShareScope = 'non-brand' | 'pooled'

export interface MentionShareResult extends ScoreSummaryDto {
  /**
   * The competitive figure: NON-BRAND queries only whenever the caller supplied
   * a classification, because a branded query is one the model was already
   * handed your name on and a competitor structurally cannot win it.
   *
   * Falls back to the pooled set only when nothing could be classified, and
   * `scope` says which of the two the reader is looking at.
   */
  breakdown: MentionShareBreakdown
  scope: MentionShareScope
  /**
   * Branded queries, kept visible and kept separate. This is recognition
   * ("when asked about you, does the model know you?"), not placement — it must
   * never be pooled into `breakdown`, and it is never null so a surface can
   * always render the second section rather than silently dropping the data.
   */
  branded: MentionShareBreakdown
}

interface ClassTally {
  projectMentionSnapshots: number
  snapshotsWithAnswerText: number
  snapshotsTotal: number
  competitorCounts: Map<string, number>
}

function emptyTally(competitors: readonly MentionShareCompetitor[]): ClassTally {
  return {
    projectMentionSnapshots: 0,
    snapshotsWithAnswerText: 0,
    snapshotsTotal: 0,
    competitorCounts: new Map(competitors.map(c => [c.domain, 0])),
  }
}

function toBreakdown(tally: ClassTally, competitors: readonly MentionShareCompetitor[]): MentionShareBreakdown {
  const competitorMentionSnapshots = [...tally.competitorCounts.values()].reduce((a, b) => a + b, 0)
  const denom = tally.projectMentionSnapshots + competitorMentionSnapshots
  const perCompetitor: MentionShareCompetitorRow[] = competitors
    .map(c => ({
      domain: c.domain,
      mentionSnapshots: tally.competitorCounts.get(c.domain) ?? 0,
      shareOfCompetitiveTotal: percentOf(tally.competitorCounts.get(c.domain) ?? 0, competitorMentionSnapshots) ?? 0,
    }))
    .filter(row => row.mentionSnapshots > 0)
    .sort((a, b) => b.mentionSnapshots - a.mentionSnapshots || (a.domain < b.domain ? -1 : 1))

  return {
    projectMentionSnapshots: tally.projectMentionSnapshots,
    competitorMentionSnapshots,
    perCompetitor,
    snapshotsWithAnswerText: tally.snapshotsWithAnswerText,
    snapshotsTotal: tally.snapshotsTotal,
    score: percentOf(tally.projectMentionSnapshots, denom),
  }
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
 * SCOPED TO NON-BRAND QUERIES. A query that contains your own name is one the
 * model has already been told who you are on: you are named in it ~always and a
 * competitor structurally cannot be, so a pooled denominator lets branded recall
 * carry the category number. Measured on a real basket (13 queries × 4
 * providers, 5 of them branded) the pooled figure ranked the subject FIRST at
 * 42% while the non-brand figure ranked them LAST at 3% — the same run, the
 * opposite conclusion. Branded is still returned, under `branded`, because it is
 * a real signal about recognition; it is simply not this one.
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
  // One compiled matcher per competitor, reused across every answer: the alias
  // set is fixed and the answer corpus is not.
  const competitorMatchers = new Map<string, BrandAliasMatcher>(
    options.competitors.map(c => [c.domain, compileBrandAliases(usableBrandAliases([...c.brandTokens]))]),
  )

  const nonBrand = emptyTally(options.competitors)
  const branded = emptyTally(options.competitors)
  // Snapshots the caller could not classify. They are pooled ONLY when nothing
  // at all was classified; a partially-classified basket would otherwise quietly
  // put branded rows back into the competitive figure.
  const unclassified = emptyTally(options.competitors)

  for (const snap of snapshots) {
    const tally = snap.queryClass === 'branded'
      ? branded
      : snap.queryClass === 'non-brand'
        ? nonBrand
        : unclassified
    tally.snapshotsTotal++
    const text = snap.answerText ?? ''
    if (text.length === 0) continue
    tally.snapshotsWithAnswerText++
    if (snap.projectMentioned) tally.projectMentionSnapshots++
    for (const competitor of options.competitors) {
      const matcher = competitorMatchers.get(competitor.domain)
      if (matcher && matcherMatchesText(matcher, text)) {
        tally.competitorCounts.set(competitor.domain, (tally.competitorCounts.get(competitor.domain) ?? 0) + 1)
      }
    }
  }

  const classified = nonBrand.snapshotsTotal + branded.snapshotsTotal
  // A populated classified basket proves a classifier exists. The explicit
  // hint covers the empty-window case, where the rows alone cannot prove it.
  const classificationAvailable = options.classificationAvailable === true || classified > 0
  const scope: MentionShareScope = classificationAvailable ? 'non-brand' : 'pooled'
  let headline = toBreakdown(scope === 'non-brand' ? nonBrand : unclassified, options.competitors)
  let brandedBreakdown = toBreakdown(branded, options.competitors)
  const tooltip = scope === 'non-brand'
    ? 'On queries that do NOT contain your name, the % of brand-name-drops in AI answers that are you vs your tracked competitors. Branded queries are excluded on purpose: you are named on almost all of them and a competitor cannot be, so pooling them would hide how you place in your category.'
    : 'The % of brand-name-drops in AI answers that are you vs your tracked competitors across all tracked queries. This project has no usable brand alias, so branded and non-brand queries could not be separated and the result is labelled pooled.'

  if (snapshots.length === 0) {
    return {
      label: 'Mention Share',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'No mention share data yet. Trigger a run to start tracking.',
      tooltip,
      trend: [],
      scope,
      breakdown: headline,
      branded: brandedBreakdown,
    }
  }

  if (options.competitors.length === 0) {
    // Keep the observed class and project counts, but never expose the
    // project-only denominator as a 100% competitive score.
    headline = { ...headline, score: null }
    brandedBreakdown = { ...brandedBreakdown, score: null }
    return {
      label: 'Mention Share',
      value: 'Add competitors',
      delta: 'No competitors configured',
      tone: 'neutral',
      description: 'Mention Share is a head-to-head competitive metric — add tracked competitors to compare brand mention rates.',
      tooltip,
      trend: [],
      scope,
      breakdown: headline,
      branded: brandedBreakdown,
    }
  }

  const score = headline.score
  const denom = headline.projectMentionSnapshots + headline.competitorMentionSnapshots

  if (scope === 'non-brand' && nonBrand.snapshotsTotal === 0) {
    return {
      label: 'Mention Share',
      value: 'No non-brand queries',
      delta: branded.snapshotsTotal > 0
        ? `${branded.snapshotsTotal} branded ${branded.snapshotsTotal === 1 ? 'snapshot' : 'snapshots'} only`
        : 'No answers to score',
      tone: 'neutral',
      description: 'Every tracked query names your brand. Branded queries measure recognition, not competitive placement — add category queries to measure where you place.',
      tooltip,
      trend: [],
      scope,
      breakdown: headline,
      branded: brandedBreakdown,
    }
  }

  if (headline.snapshotsTotal > 0 && headline.snapshotsWithAnswerText === 0) {
    const brandedAnswers = brandedBreakdown.snapshotsWithAnswerText
    return {
      label: 'Mention Share',
      value: scope === 'non-brand' ? 'No non-brand answers' : 'No answers',
      delta: scope === 'non-brand' && brandedAnswers > 0
        ? `${brandedAnswers} branded ${brandedAnswers === 1 ? 'answer' : 'answers'} only`
        : 'No answers to score',
      tone: 'neutral',
      description: scope === 'non-brand'
        ? 'Non-brand queries are tracked, but no answer text was recorded for them in this run.'
        : 'Tracked queries exist, but no answer text was recorded in this run.',
      tooltip,
      trend: [],
      scope,
      breakdown: headline,
      branded: brandedBreakdown,
    }
  }

  if (score === null) {
    return {
      label: 'Mention Share',
      value: 'No mentions',
      delta: scopeLabel(scope, 'No brand mentions in this run'),
      tone: 'neutral',
      description: describe({ scope, breakdown: headline, branded: brandedBreakdown }),
      tooltip,
      trend: [],
      scope,
      breakdown: headline,
      branded: brandedBreakdown,
    }
  }

  return {
    label: 'Mention Share',
    value: formatPercent(headline.projectMentionSnapshots / denom),
    delta: scopeLabel(scope, `${headline.projectMentionSnapshots} of ${denom} brand mentions`),
    tone: mentionShareTone(score),
    description: describe({ scope, breakdown: headline, branded: brandedBreakdown }),
    tooltip,
    trend: [],
    progress: score,
    scope,
    breakdown: headline,
    branded: brandedBreakdown,
  }
}

/**
 * The scope travels with the number wherever the number goes. A reader who sees
 * only the delta line must still be able to tell a category figure from a
 * pooled one, because those two answer opposite questions.
 */
function scopeLabel(scope: MentionShareScope, body: string): string {
  return scope === 'non-brand'
    ? `${body} · non-brand queries`
    : `${body} · pooled queries · classification unavailable`
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

function describe(parts: {
  scope: MentionShareScope
  breakdown: MentionShareBreakdown
  branded: MentionShareBreakdown
}): string {
  const { scope, breakdown, branded } = parts
  const { projectMentionSnapshots, competitorMentionSnapshots, perCompetitor } = breakdown
  const where = scope === 'non-brand' ? 'on non-brand queries' : 'across your tracked queries'
  // Branded recall is the sentence that stops a 3% category number reading as a
  // measurement failure — and stops a 100% branded number reading as category
  // strength. It is stated next to the figure, never inside it.
  const brandedNote = branded.snapshotsWithAnswerText > 0 && branded.score !== null
    ? ` Separately, you are named in ${branded.projectMentionSnapshots} of ${branded.snapshotsWithAnswerText} answers to queries that contain your name.`
    : ''

  if (projectMentionSnapshots === 0 && competitorMentionSnapshots === 0) {
    return `No brand mentions detected for you or your tracked competitors ${where}.${brandedNote}`
  }
  if (competitorMentionSnapshots === 0) {
    return `${projectMentionSnapshots} brand mentions of you and zero competitor mentions ${where} — you own the conversation.${brandedNote}`
  }
  const top = perCompetitor[0]
  const total = projectMentionSnapshots + competitorMentionSnapshots
  // The unrounded share, so the sentence and the gauge's `value` read alike.
  const share = formatPercent(projectMentionSnapshots / total)
  if (!top) {
    return `${share} of brand mentions ${where} are you (${projectMentionSnapshots} of ${total}).${brandedNote}`
  }
  return `${share} of brand mentions ${where} are you. Top competitor: ${top.domain} (${top.mentionSnapshots} mentions).${brandedNote}`
}
