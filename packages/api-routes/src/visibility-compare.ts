import { buildMentionShare } from '@ainyc/canonry-intelligence'
import {
  answerProseForMentions,
  CitationStates,
  compileBrandAliases,
  compileQueryClassifier,
  hostOf,
  hostMatchesDomain,
  matcherMatchesText,
  wilsonInterval,
  type BrandAliasMatcher,
  type QueryClass,
  type VisibilityCompareDto,
  type VisibilityCompareMetric,
  type VisibilityCompareMetricKey,
  type VisibilityCompareMetricPeriod,
  type VisibilityCompareContinuityStatus,
  type VisibilityCompareProviderRow,
  type VisibilityStatsShareCompetitor,
} from '@ainyc/canonry-contracts'
import { buildQueryAttribution, resolveCurrentQuery } from './visibility-stats.js'
import { classifyModelEvidence, compareModelContinuity } from './model-evidence.js'

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
  /** Frozen Advanced scope identity; absent for the legacy simple basket. */
  cohortKey?: string
  queryClass?: QueryClass | null
  /** Advanced source capture can be incomplete independently of mentions. */
  citationChecked?: boolean
  /** False when no selected Target is mention-eligible: the row has no mention signal, known or unknown. */
  mentionApplicable?: boolean
  competitorDomains?: string[]
  competitorMentions?: string[]
  competitorCitations?: string[]
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
  /** Advanced class populations reuse an answer once per class, with scoped Target attribution. */
  classSnapshots?: VisibilityCompareSnapshotInput[]
}

export interface ComputeVisibilityCompareInput {
  project: string
  queries: Array<{ id: string; query: string }>
  from: VisibilityComparePeriodInput
  to: VisibilityComparePeriodInput
  competitors: VisibilityCompareCompetitorInput[]
  /**
   * Project brand aliases, used to split the basket into branded and non-brand.
   * Share of voice is the metric this comparison leads with, so it reads the
   * non-brand class only: pooling branded queries in would make a month whose
   * basket gained a branded query look like a month that gained category share.
   * Empty means no split was possible and the figure stays pooled.
   */
  brandNames?: readonly string[]
  frozenClassification?: boolean
}

interface Attributed extends VisibilityCompareSnapshotInput {
  queryId: string // non-null after attribution
}

interface BasketPair {
  queryId: string
  provider: string
  cohortKey?: string
}

function basketPairKey(queryId: string, provider: string, cohortKey?: string): string {
  return JSON.stringify([queryId, provider, cohortKey ?? null])
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
    if (!pairs.has(basketPairKey(resolved.id, snap.provider, snap.cohortKey))) continue
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
    const pair = { queryId: resolved.id, provider: snap.provider, cohortKey: snap.cohortKey }
    pairs.set(basketPairKey(pair.queryId, pair.provider, pair.cohortKey), pair)
  }
  return pairs
}

function period(numerator: number, denominator: number): VisibilityCompareMetricPeriod {
  const ci = wilsonInterval(numerator, denominator)
  return {
    availability: denominator > 0 ? 'available' : 'no-observations',
    point: denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null,
    ciLow: ci ? ci.low : null,
    ciHigh: ci ? ci.high : null,
    numerator,
    denominator,
  }
}

/** Keep observed project evidence without turning a project-only count into 100% share. */
function unavailableCompetitivePeriod(numerator: number): VisibilityCompareMetricPeriod {
  return {
    availability: 'no-competitive-frame',
    point: null,
    ciLow: null,
    ciHigh: null,
    numerator,
    denominator: 0,
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
  queryClass: VisibilityCompareMetric['queryClass'],
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
  return { key, label, queryClass, driftRobust, from, to, rateRatio, direction, verdict }
}

/** Counts one period's snapshots contribute to every metric, over the basket. */
interface PeriodCounts {
  checked: number // answerMentioned is a boolean (the mention denominator)
  mentioned: number // answerMentioned === true
  total: number // snapshots whose source capture is complete (the citation denominator)
  cited: number // citationState === 'cited'
  /** Snapshots with incomplete source capture, excluded from every citation figure. */
  citationUnknown: number
  /** The frame records capture completeness (Advanced); legacy rows are always complete. */
  citationEvidence: boolean
  projectCited: number // = cited (project's own citation)
  competitorCited: number // sum over competitors of snapshots citing that competitor
  queriesMentioned: number // distinct basket queries mentioned by >= 1 provider
  perProvider: Map<string, { checked: number; mentioned: number; cited: number }>
  mentionShare: { breakdown: { projectMentionSnapshots: number; competitorMentionSnapshots: number; perCompetitor: Array<{ domain: string; mentionSnapshots: number }> } }
  competitors: VisibilityStatsShareCompetitor[]
}

/** Raw provider model evidence; classification stays shared with analytics trends. */
function modelEvidenceOf(snaps: readonly Attributed[]): Map<string, Array<string | null>> {
  const evidence = new Map<string, Array<string | null>>()
  for (const snap of snaps) {
    const models = evidence.get(snap.provider) ?? []
    models.push(snap.model)
    evidence.set(snap.provider, models)
  }
  return evidence
}

function countPeriod(
  snaps: Attributed[],
  competitors: VisibilityCompareCompetitorInput[],
  queryClassOf: (snap: Attributed) => QueryClass | null,
  classificationAvailable: boolean,
  projectMatcher: BrandAliasMatcher,
): PeriodCounts {
  let checked = 0
  let mentioned = 0
  let total = 0
  let cited = 0
  let citationUnknown = 0
  let competitorCited = 0
  const perProvider = new Map<string, { checked: number; mentioned: number; cited: number }>()
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
    // An incomplete source list proves neither a citation nor its absence, for
    // the project or a competitor, so the row leaves every citation figure.
    const citationKnown = snap.citationChecked !== false
    if (citationKnown) total += 1
    else citationUnknown += 1
    const isCited = citationKnown && snap.citationState === CitationStates.cited
    if (isCited) cited += 1

    const pp = perProvider.get(snap.provider) ?? { checked: 0, mentioned: 0, cited: 0 }
    if (snap.answerMentioned === true || snap.answerMentioned === false) pp.checked += 1
    if (isMentioned) pp.mentioned += 1
    if (isCited) pp.cited += 1
    perProvider.set(snap.provider, pp)

    if (!citationKnown) continue
    // Competitor citation, per-snapshot per-competitor (mirrors buildMentionShare's
    // competitor counting: a snapshot citing two competitors adds two).
    if (snap.competitorCitations !== undefined) competitorCited += snap.competitorCitations.length
    else if (competitorHosts.length > 0 && snap.citedDomains.length > 0) {
      const citedHosts = snap.citedDomains
        .map((d) => hostOf(d))
        .filter((h): h is string => h !== null && h.length > 0)
      for (const compHost of competitorHosts) {
        if (citedHosts.some((ch) => hostMatchesDomain(ch, compHost))) competitorCited += 1
      }
    }
  }

  let mentionShare: PeriodCounts['mentionShare'] = buildMentionShare(
    snaps.map((s) => ({
      // Share uses current identity; named-rate counts above deliberately keep
      // their historical persisted-boolean semantics.
      projectMentioned: s.answerText
        ? matcherMatchesText(projectMatcher, answerProseForMentions(s.answerText))
        : s.answerMentioned === true,
      answerText: s.answerText,
      queryClass: queryClassOf(s),
    })),
    { competitors, classificationAvailable },
  )

  if (snaps.some(snapshot => snapshot.competitorMentions !== undefined)) {
    // Same scope as buildMentionShare: non-brand when classified, pooled (and
    // labelled pooled) only when nothing could be classified.
    const selected = snaps.filter(snapshot => (!classificationAvailable || queryClassOf(snapshot) === 'non-brand') && snapshot.answerMentioned !== null)
    // Same rows as buildMentionShare: named competitors only, most-named first.
    const perCompetitor = competitors.map(competitor => ({
      domain: competitor.domain,
      mentionSnapshots: selected.filter(snapshot => snapshot.competitorMentions?.includes(competitor.domain)).length,
    }))
      .filter(row => row.mentionSnapshots > 0)
      .sort((a, b) => b.mentionSnapshots - a.mentionSnapshots || (a.domain < b.domain ? -1 : 1))
    mentionShare = { ...mentionShare, breakdown: { ...mentionShare.breakdown,
      projectMentionSnapshots: selected.filter(snapshot => snapshot.answerMentioned === true).length,
      competitorMentionSnapshots: perCompetitor.reduce((total, competitor) => total + competitor.mentionSnapshots, 0),
      perCompetitor,
    } }
  }

  return {
    checked,
    mentioned,
    total,
    cited,
    citationUnknown,
    citationEvidence: snaps.some(snapshot => snapshot.citationChecked !== undefined),
    projectCited: cited,
    competitorCited,
    queriesMentioned: mentionedQueries.size,
    perProvider,
    mentionShare,
    competitors: mentionShare.breakdown.perCompetitor.map((c) => ({ domain: c.domain, mentions: c.mentionSnapshots })),
  }
}

function modelIds(evidence: ReturnType<typeof classifyModelEvidence>): string[] {
  if (evidence.status === 'known') return [evidence.model]
  if (evidence.status === 'mixed') return evidence.models
  return []
}

/**
 * Month-over-month AEO comparison — pure, deterministic, no I/O (mirrors the
 * `gbp-summary.ts` precedent). See `visibility-stats.ts` DTO comments for the
 * method the statistician panel scoped: SoV-led, basket-restricted, Wilson
 * intervals, CI-overlap verdict, drift-aware.
 */
export function computeVisibilityCompare(input: ComputeVisibilityCompareInput): VisibilityCompareDto {
  const attribution = buildQueryAttribution(input.queries)

  // Classify once against the CURRENT tracked text, so the same query lands in
  // the same class in both periods. Classifying each period against its own
  // snapshots would let a rename move a query between classes mid-comparison,
  // which is exactly the kind of basket churn this function exists to exclude.
  const classifier = compileQueryClassifier(input.brandNames ?? [])
  const classificationAvailable = input.frozenClassification === true || classifier !== null
  const queryTextById = new Map(input.queries.map((q) => [q.id, q.query]))
  const queryClassOf = (snap: Attributed): QueryClass | null =>
    input.frozenClassification ? snap.queryClass ?? null : classifier ? classifier.classify(queryTextById.get(snap.queryId) ?? snap.queryText) : null
  // Compiled once for every answer and matched against the answer's prose;
  // same identity rule as `determineAnswerMentioned(text, brandNames, [])`.
  const projectMatcher = compileBrandAliases(input.brandNames ?? [])

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
  // The pre-continuity basket decides which providers stay comparable, and that
  // gate reads model evidence only. Its answers are matched once, below.
  const fromCandidateModels = modelEvidenceOf(restrict(input.from.snapshots, attribution, pairsBoth))
  const toCandidateModels = modelEvidenceOf(restrict(input.to.snapshots, attribution, pairsBoth))
  const continuityProviders = [...candidateProviders]
    .sort((a, b) => a.localeCompare(b))
    .map((provider) => {
      return { provider, ...compareModelContinuity(
        fromCandidateModels.get(provider) ?? [],
        toCandidateModels.get(provider) ?? [],
      ) }
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

  const fromCounts = countPeriod(fromSnaps, input.competitors, queryClassOf, classificationAvailable, projectMatcher)
  const toCounts = countPeriod(toSnaps, input.competitors, queryClassOf, classificationAvailable, projectMatcher)

  const fromClassSnaps = input.from.classSnapshots === undefined ? fromSnaps : restrict(input.from.classSnapshots, attribution, comparedPairs)
  const toClassSnaps = input.to.classSnapshots === undefined ? toSnaps : restrict(input.to.classSnapshots, attribution, comparedPairs)
  // Frozen share of voice reads each row's stored Target mention, never answer text.
  const noProjectMatcher = compileBrandAliases([])
  const fromShareCounts = input.frozenClassification ? countPeriod(fromClassSnaps, input.competitors, queryClassOf, true, noProjectMatcher) : fromCounts
  const toShareCounts = input.frozenClassification ? countPeriod(toClassSnaps, input.competitors, queryClassOf, true, noProjectMatcher) : toCounts

  const shareCounts = (c: PeriodCounts): { proj: number; comp: number } => ({
    proj: c.mentionShare.breakdown.projectMentionSnapshots,
    comp: c.mentionShare.breakdown.competitorMentionSnapshots,
  })
  const fromShare = shareCounts(fromShareCounts)
  const toShare = shareCounts(toShareCounts)

  // Frames that record capture completeness say how many rows each citation
  // figure had to leave out; legacy frames are complete by construction.
  const citationPeriod = (c: PeriodCounts, value: VisibilityCompareMetricPeriod): VisibilityCompareMetricPeriod =>
    c.citationEvidence ? { ...value, excludedUnknown: c.citationUnknown } : value

  const metrics: VisibilityCompareMetric[] = [
    metric(
      'mention-share-of-voice',
      'Named share of voice',
      classificationAvailable ? 'non-brand' : 'pooled',
      true,
      input.competitors.length > 0
        ? period(fromShare.proj, fromShare.proj + fromShare.comp)
        : unavailableCompetitivePeriod(fromShare.proj),
      input.competitors.length > 0
        ? period(toShare.proj, toShare.proj + toShare.comp)
        : unavailableCompetitivePeriod(toShare.proj),
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
      'all',
      true,
      citationPeriod(fromCounts, input.competitors.length > 0
        ? period(fromCounts.projectCited, fromCounts.projectCited + fromCounts.competitorCited)
        : unavailableCompetitivePeriod(fromCounts.projectCited)),
      citationPeriod(toCounts, input.competitors.length > 0
        ? period(toCounts.projectCited, toCounts.projectCited + toCounts.competitorCited)
        : unavailableCompetitivePeriod(toCounts.projectCited)),
      continuityBlock,
    ),
    metric(
      'mention-rate',
      'Named rate',
      'all',
      false,
      period(fromCounts.mentioned, fromCounts.checked),
      period(toCounts.mentioned, toCounts.checked),
      continuityBlock,
    ),
    metric(
      'cited-rate',
      'Cited rate',
      'all',
      false,
      citationPeriod(fromCounts, period(fromCounts.cited, fromCounts.total)),
      citationPeriod(toCounts, period(toCounts.cited, toCounts.total)),
      continuityBlock,
    ),
  ]

  const classPeriod = (snapshots: Attributed[], queryClass: QueryClass, signal: 'mention' | 'cited'): VisibilityCompareMetricPeriod => {
    if (!classificationAvailable) return { ...period(0, 0), availability: 'classification-unavailable' }
    // A row whose Targets are all mention-ineligible has no mention signal at
    // all; it is not an unknown one.
    const selected = snapshots.filter(snapshot => queryClassOf(snapshot) === queryClass
      && (signal === 'cited' || snapshot.mentionApplicable !== false))
    const checked = selected.filter(snapshot => signal === 'mention'
      ? typeof snapshot.answerMentioned === 'boolean'
      : snapshot.citationChecked !== false)
    const numerator = checked.filter(snapshot => signal === 'mention'
      ? snapshot.answerMentioned === true
      : snapshot.citationState === CitationStates.cited).length
    return { ...period(numerator, checked.length), excludedUnknown: selected.length - checked.length }
  }
  for (const queryClass of ['branded', 'non-brand'] as const) {
    for (const signal of ['mention', 'cited'] as const) {
      metrics.push(metric(
        `${signal}-rate-${queryClass}`,
        signal === 'mention' ? 'Mention rate' : 'Cited rate',
        queryClass,
        false,
        classPeriod(fromClassSnaps, queryClass, signal),
        classPeriod(toClassSnaps, queryClass, signal),
        continuityBlock,
      ))
    }
  }

  // Model changes are reported over the pre-continuity pair basket so a
  // discontinuous provider remains visible even though it is excluded from the
  // directional metrics.
  const modelChanges = [...candidateProviders]
    .sort((a, b) => a.localeCompare(b))
    .map((provider) => {
      const fromModels = modelIds(classifyModelEvidence(fromCandidateModels.get(provider) ?? []))
      const toModels = modelIds(classifyModelEvidence(toCandidateModels.get(provider) ?? []))
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
    competitors: { from: fromShareCounts.competitors, to: toShareCounts.competitors },
  }
}
