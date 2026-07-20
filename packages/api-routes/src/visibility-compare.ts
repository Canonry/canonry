import { buildMentionShare } from '@ainyc/canonry-intelligence'
import {
  CitationStates,
  hostOf,
  wilsonInterval,
  type VisibilityCompareDto,
  type VisibilityCompareMetric,
  type VisibilityCompareMetricKey,
  type VisibilityCompareMetricPeriod,
  type VisibilityCompareContinuityStatus,
  type VisibilityCompareProviderContinuityStatus,
  type VisibilityCompareProviderRow,
  type VisibilityStatsShareCompetitor,
} from '@ainyc/canonry-contracts'
import { buildQueryAttribution, resolveCurrentQuery } from './visibility-stats.js'
import { classifyModelEvidence } from './model-evidence.js'

/** Runs below this many sweeps in a month make every interval too wide to resolve a move. */
export const VISIBILITY_COMPARE_MIN_RUNS = 5

/** One snapshot the comparison reads. `citedDomains` are the grounding hostnames; `model` is the configured model id. */
export interface VisibilityCompareSnapshotInput {
  queryId: string | null
  queryText: string | null
  provider: string
  model: string | null
  citationState: string
  answerMentioned: boolean | null
  answerText: string | null
  citedDomains: string[]
}

export interface VisibilityCompareCompetitorInput {
  domain: string
  brandTokens: readonly string[]
}

export interface VisibilityComparePeriodInput {
  month: string
  since: string
  until: string
  runCount: number
  snapshots: VisibilityCompareSnapshotInput[]
}

export interface ComputeVisibilityCompareInput {
  project: string
  queries: Array<{ id: string; query: string }>
  from: VisibilityComparePeriodInput
  to: VisibilityComparePeriodInput
  competitors: VisibilityCompareCompetitorInput[]
}

interface Attributed extends VisibilityCompareSnapshotInput {
  queryId: string // non-null after attribution
}

interface BasketPair {
  queryId: string
  provider: string
}

function basketPairKey(queryId: string, provider: string): string {
  return JSON.stringify([queryId, provider])
}

/** A cited hostname belongs to a competitor when it equals or is a subdomain of the competitor's host. */
function citedHostMatches(citedHost: string, competitorHost: string): boolean {
  return citedHost === competitorHost || citedHost.endsWith(`.${competitorHost}`)
}

/** Attribute snapshots to currently-tracked queries (drop the rest), restricted to the common query/provider-pair basket. */
function restrict(
  snapshots: VisibilityCompareSnapshotInput[],
  attribution: ReturnType<typeof buildQueryAttribution>,
  pairs: ReadonlyMap<string, BasketPair>,
): Attributed[] {
  const out: Attributed[] = []
  for (const snap of snapshots) {
    const resolved = resolveCurrentQuery(attribution, snap)
    if (!resolved) continue
    if (!pairs.has(basketPairKey(resolved.id, snap.provider))) continue
    out.push({ ...snap, queryId: resolved.id })
  }
  return out
}

/** Distinct current-query ids and providers a period observed (pre-basket). */
function observed(
  snapshots: VisibilityCompareSnapshotInput[],
  attribution: ReturnType<typeof buildQueryAttribution>,
): { queryIds: Set<string>; providers: Set<string> } {
  const queryIds = new Set<string>()
  const providers = new Set<string>()
  for (const snap of snapshots) {
    const resolved = resolveCurrentQuery(attribution, snap)
    if (!resolved) continue
    queryIds.add(resolved.id)
    providers.add(snap.provider)
  }
  return { queryIds, providers }
}

/** Query/provider pairs a period observed on the given (common) queries. */
function observedPairs(
  snapshots: VisibilityCompareSnapshotInput[],
  attribution: ReturnType<typeof buildQueryAttribution>,
  queryIds: ReadonlySet<string>,
): Map<string, BasketPair> {
  const pairs = new Map<string, BasketPair>()
  for (const snap of snapshots) {
    const resolved = resolveCurrentQuery(attribution, snap)
    if (!resolved || !queryIds.has(resolved.id)) continue
    const pair = { queryId: resolved.id, provider: snap.provider }
    pairs.set(basketPairKey(pair.queryId, pair.provider), pair)
  }
  return pairs
}

function period(numerator: number, denominator: number): VisibilityCompareMetricPeriod {
  const ci = wilsonInterval(numerator, denominator)
  return {
    point: denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null,
    ciLow: ci ? ci.low : null,
    ciHigh: ci ? ci.high : null,
    numerator,
    denominator,
  }
}

/** Two Wilson intervals overlap iff neither sits entirely beyond the other. */
function ciOverlap(a: VisibilityCompareMetricPeriod, b: VisibilityCompareMetricPeriod): boolean {
  if (a.ciLow === null || a.ciHigh === null || b.ciLow === null || b.ciHigh === null) return true
  return a.ciLow <= b.ciHigh && b.ciLow <= a.ciHigh
}

function metric(
  key: VisibilityCompareMetricKey,
  label: string,
  driftRobust: boolean,
  from: VisibilityCompareMetricPeriod,
  to: VisibilityCompareMetricPeriod,
  continuityBlock: 'model-discontinuous' | 'model-unknown' | null,
): VisibilityCompareMetric {
  const verdict =
    continuityBlock ??
    (from.denominator === 0 || to.denominator === 0
      ? 'insufficient-data'
      : ciOverlap(from, to)
        ? 'within-noise'
        : 'moved')
  const direction =
    from.point === null || to.point === null
      ? null
      : to.point > from.point
        ? 'up'
        : to.point < from.point
          ? 'down'
          : 'flat'
  const rateRatio =
    from.point === null || from.point === 0 || to.point === null
      ? null
      : Math.round((to.point / from.point) * 100) / 100
  return { key, label, driftRobust, from, to, rateRatio, direction, verdict }
}

/** Counts one period's snapshots contribute to every metric, over the basket. */
interface PeriodCounts {
  checked: number // answerMentioned is a boolean (the mention denominator)
  mentioned: number // answerMentioned === true
  total: number // every snapshot (the citation denominator)
  cited: number // citationState === 'cited'
  projectCited: number // = cited (project's own citation)
  competitorCited: number // sum over competitors of snapshots citing that competitor
  queriesMentioned: number // distinct basket queries mentioned by >= 1 provider
  perProvider: Map<string, { checked: number; mentioned: number; cited: number }>
  /** Raw provider evidence; classification stays shared with analytics trends. */
  modelEvidence: Map<string, Array<string | null>>
  mentionShare: ReturnType<typeof buildMentionShare>
  competitors: VisibilityStatsShareCompetitor[]
}

function countPeriod(snaps: Attributed[], competitors: VisibilityCompareCompetitorInput[]): PeriodCounts {
  let checked = 0
  let mentioned = 0
  let cited = 0
  let competitorCited = 0
  const perProvider = new Map<string, { checked: number; mentioned: number; cited: number }>()
  const modelEvidence = new Map<string, Array<string | null>>()
  const mentionedQueries = new Set<string>()

  // Normalize competitor hosts once; a competitor with an unparseable domain
  // contributes no cited match rather than throwing.
  const competitorHosts = competitors
    .map((c) => hostOf(c.domain))
    .filter((h): h is string => h !== null && h.length > 0)

  for (const snap of snaps) {
    const isMentioned = snap.answerMentioned === true
    if (snap.answerMentioned === true || snap.answerMentioned === false) checked += 1
    if (isMentioned) {
      mentioned += 1
      mentionedQueries.add(snap.queryId)
    }
    const isCited = snap.citationState === CitationStates.cited
    if (isCited) cited += 1

    const pp = perProvider.get(snap.provider) ?? { checked: 0, mentioned: 0, cited: 0 }
    if (snap.answerMentioned === true || snap.answerMentioned === false) pp.checked += 1
    if (isMentioned) pp.mentioned += 1
    if (isCited) pp.cited += 1
    perProvider.set(snap.provider, pp)

    const models = modelEvidence.get(snap.provider) ?? []
    models.push(snap.model)
    modelEvidence.set(snap.provider, models)

    // Competitor citation, per-snapshot per-competitor (mirrors buildMentionShare's
    // competitor counting: a snapshot citing two competitors adds two).
    if (competitorHosts.length > 0 && snap.citedDomains.length > 0) {
      const citedHosts = snap.citedDomains
        .map((d) => hostOf(d))
        .filter((h): h is string => h !== null && h.length > 0)
      for (const compHost of competitorHosts) {
        if (citedHosts.some((ch) => citedHostMatches(ch, compHost))) competitorCited += 1
      }
    }
  }

  const mentionShare = buildMentionShare(
    snaps.map((s) => ({ projectMentioned: s.answerMentioned === true, answerText: s.answerText })),
    { competitors },
  )

  return {
    checked,
    mentioned,
    total: snaps.length,
    cited,
    projectCited: cited,
    competitorCited,
    queriesMentioned: mentionedQueries.size,
    perProvider,
    modelEvidence,
    mentionShare,
    competitors: mentionShare.breakdown.perCompetitor.map((c) => ({ domain: c.domain, mentions: c.mentionSnapshots })),
  }
}

function modelIds(evidence: ReturnType<typeof classifyModelEvidence>): string[] {
  if (evidence.status === 'known') return [evidence.model]
  if (evidence.status === 'mixed') return evidence.models
  return []
}

/** Unknown or partially legacy evidence cannot support a continuity verdict. */
function isUnknownModelEvidence(evidence: ReturnType<typeof classifyModelEvidence>): boolean {
  return evidence.status === 'unknown' || (evidence.status === 'mixed' && evidence.includesUnknown)
}

/**
 * Month-over-month AEO comparison — pure, deterministic, no I/O (mirrors the
 * `gbp-summary.ts` precedent). See `visibility-stats.ts` DTO comments for the
 * method the statistician panel scoped: SoV-led, basket-restricted, Wilson
 * intervals, CI-overlap verdict, drift-aware.
 */
export function computeVisibilityCompare(input: ComputeVisibilityCompareInput): VisibilityCompareDto {
  const attribution = buildQueryAttribution(input.queries)

  const fromObs = observed(input.from.snapshots, attribution)
  const toObs = observed(input.to.snapshots, attribution)

  // BASKET: only query/provider PAIRS observed in BOTH periods are compared.
  // Intersecting query ids and provider names separately would still admit a
  // provider on different queries in each month, making coverage churn look
  // like a visibility move.
  const queriesObservedBoth = new Set([...fromObs.queryIds].filter((q) => toObs.queryIds.has(q)))
  const fromPairs = observedPairs(input.from.snapshots, attribution, queriesObservedBoth)
  const toPairs = observedPairs(input.to.snapshots, attribution, queriesObservedBoth)
  const pairsBoth = new Map([...fromPairs].filter(([key]) => toPairs.has(key)))
  const candidateProviders = new Set([...pairsBoth.values()].map((pair) => pair.provider))
  const fromCandidateSnaps = restrict(input.from.snapshots, attribution, pairsBoth)
  const toCandidateSnaps = restrict(input.to.snapshots, attribution, pairsBoth)
  const fromCandidateCounts = countPeriod(fromCandidateSnaps, input.competitors)
  const toCandidateCounts = countPeriod(toCandidateSnaps, input.competitors)
  const continuityProviders = [...candidateProviders]
    .sort((a, b) => a.localeCompare(b))
    .map((provider) => {
      const fromEvidence = classifyModelEvidence(fromCandidateCounts.modelEvidence.get(provider) ?? [])
      const toEvidence = classifyModelEvidence(toCandidateCounts.modelEvidence.get(provider) ?? [])
      const fromModels = modelIds(fromEvidence)
      const toModels = modelIds(toEvidence)
      const status: VisibilityCompareProviderContinuityStatus =
        isUnknownModelEvidence(fromEvidence) || isUnknownModelEvidence(toEvidence)
          ? 'model-unknown'
          : fromEvidence.status === 'known' && toEvidence.status === 'known' && fromEvidence.model === toEvidence.model
            ? 'included'
            : 'model-discontinuous'
      return { provider, status, fromModels, toModels }
    })
  const providersBoth = new Set(
    continuityProviders.filter((provider) => provider.status === 'included').map((provider) => provider.provider),
  )
  const continuityStatus: VisibilityCompareContinuityStatus =
    candidateProviders.size === 0
      ? 'insufficient-data'
      : providersBoth.size > 0
        ? 'comparable'
        : continuityProviders.every((provider) => provider.status === 'model-unknown')
          ? 'model-unknown'
          : 'model-discontinuous'
  const continuityBlock: 'model-discontinuous' | 'model-unknown' | null =
    continuityStatus === 'model-discontinuous' || continuityStatus === 'model-unknown'
      ? continuityStatus
      : null
  const comparedPairs = new Map([...pairsBoth].filter(([, pair]) => providersBoth.has(pair.provider)))
  const queriesBoth = new Set([...comparedPairs.values()].map((pair) => pair.queryId))
  const excludedProviders = [...new Set([...fromObs.providers, ...toObs.providers])]
    .filter((p) => !providersBoth.has(p))
    .sort((a, b) => a.localeCompare(b))

  const fromSnaps = restrict(input.from.snapshots, attribution, comparedPairs)
  const toSnaps = restrict(input.to.snapshots, attribution, comparedPairs)

  const fromCounts = countPeriod(fromSnaps, input.competitors)
  const toCounts = countPeriod(toSnaps, input.competitors)

  const shareCounts = (c: PeriodCounts): { proj: number; comp: number } => ({
    proj: c.mentionShare.breakdown.projectMentionSnapshots,
    comp: c.mentionShare.breakdown.competitorMentionSnapshots,
  })
  const fromShare = shareCounts(fromCounts)
  const toShare = shareCounts(toCounts)

  const metrics: VisibilityCompareMetric[] = [
    metric(
      'mention-share-of-voice',
      'Named share of voice',
      true,
      period(fromShare.proj, fromShare.proj + fromShare.comp),
      period(toShare.proj, toShare.proj + toShare.comp),
      continuityBlock,
    ),
    // Share of voice is undefined without a competitive frame: with zero
    // configured competitors the denominator degenerates to the project's own
    // count and the metric would fabricate a 100%. buildMentionShare already
    // refuses that on the mention side ("reporting 100% would mislead");
    // degrade the cited side identically to a 0/0 period -> insufficient-data.
    metric(
      'cited-share-of-voice',
      'Cited share of voice',
      true,
      input.competitors.length > 0
        ? period(fromCounts.projectCited, fromCounts.projectCited + fromCounts.competitorCited)
        : period(0, 0),
      input.competitors.length > 0
        ? period(toCounts.projectCited, toCounts.projectCited + toCounts.competitorCited)
        : period(0, 0),
      continuityBlock,
    ),
    metric(
      'mention-rate',
      'Named rate',
      false,
      period(fromCounts.mentioned, fromCounts.checked),
      period(toCounts.mentioned, toCounts.checked),
      continuityBlock,
    ),
    metric(
      'cited-rate',
      'Cited rate',
      false,
      period(fromCounts.cited, fromCounts.total),
      period(toCounts.cited, toCounts.total),
      continuityBlock,
    ),
  ]

  // Model changes are reported over the pre-continuity pair basket so a
  // discontinuous provider remains visible even though it is excluded from the
  // directional metrics.
  const modelChanges = [...candidateProviders]
    .sort((a, b) => a.localeCompare(b))
    .map((provider) => {
      const fromModels = modelIds(classifyModelEvidence(fromCandidateCounts.modelEvidence.get(provider) ?? []))
      const toModels = modelIds(classifyModelEvidence(toCandidateCounts.modelEvidence.get(provider) ?? []))
      return { provider, fromModels, toModels }
    })
    .filter(
      (c) =>
        c.fromModels.length > 0 &&
        c.toModels.length > 0 &&
        JSON.stringify(c.fromModels) !== JSON.stringify(c.toModels),
    )

  const byProvider: VisibilityCompareProviderRow[] = [...providersBoth]
    .sort((a, b) => a.localeCompare(b))
    .map((provider) => ({
      provider,
      from: fromCounts.perProvider.get(provider) ?? { checked: 0, mentioned: 0, cited: 0 },
      to: toCounts.perProvider.get(provider) ?? { checked: 0, mentioned: 0, cited: 0 },
    }))

  return {
    project: input.project,
    from: {
      month: input.from.month,
      since: input.from.since,
      until: input.from.until,
      runCount: input.from.runCount,
      lowRunCount: input.from.runCount < VISIBILITY_COMPARE_MIN_RUNS,
    },
    to: {
      month: input.to.month,
      since: input.to.since,
      until: input.to.until,
      runCount: input.to.runCount,
      lowRunCount: input.to.runCount < VISIBILITY_COMPARE_MIN_RUNS,
    },
    basket: {
      queryCount: queriesBoth.size,
      excludedFromOnly: [...fromObs.queryIds].filter((q) => !queriesBoth.has(q)).length,
      excludedToOnly: [...toObs.queryIds].filter((q) => !queriesBoth.has(q)).length,
      providers: [...providersBoth].sort((a, b) => a.localeCompare(b)),
      excludedProviders,
    },
    metrics,
    queriesMentioned: {
      from: { count: fromCounts.queriesMentioned, of: queriesBoth.size },
      to: { count: toCounts.queriesMentioned, of: queriesBoth.size },
    },
    byProvider,
    modelChanges,
    continuity: {
      status: continuityStatus,
      comparedProviders: [...providersBoth].sort((a, b) => a.localeCompare(b)),
      providers: continuityProviders,
    },
    competitors: { from: fromCounts.competitors, to: toCounts.competitors },
  }
}
