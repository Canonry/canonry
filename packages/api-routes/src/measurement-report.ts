/**
 * Pure measurement-report engine.
 *
 * This module deliberately owns no database, provider, network, or route
 * concerns. Callers supply a frozen plan, expected execution/provider slots,
 * and stored observations. That keeps historical reconstruction explicit and
 * prevents a read from mutating or re-fetching evidence.
 */

import { normalizeMeasurementHost } from '@ainyc/canonry-contracts'

export type MeasurementAttributionClass =
  | 'assigned'
  | 'sibling'
  | 'ownedUnmapped'
  | 'external'
  | 'ambiguous'
  | 'invalid'

export type MeasurementUsageEdgeType = 'baseline' | 'target'
export type MeasurementQueryClass = 'branded' | 'non-brand'
export type MeasurementUrlMatchMode = 'exact' | 'prefix' | 'host'
export type MeasurementMetricReason =
  | 'incomplete'
  | 'evidence-incomplete'
  | 'no-population'
  | 'aliasless'
  | 'no-competitors'
  | 'no-project-aliases'

export interface MeasurementTargetUrlInput {
  id: string
  mode: MeasurementUrlMatchMode
  host: string
  path?: string
  pathCase?: 'sensitive' | 'insensitive'
}

export interface MeasurementTargetInput {
  id: string
  label: string
  aliases: readonly string[]
  urls: readonly MeasurementTargetUrlInput[]
}

export interface MeasurementCompetitorInput {
  /** Revision-pinned domain used for a comparable SoV row. */
  domain: string
  aliases: readonly string[]
}

export interface MeasurementGroupInput {
  id: string
  label: string
  targetIds: readonly string[]
  competitors: readonly MeasurementCompetitorInput[]
}

export interface MeasurementExpectedSlotInput {
  id: string
  executionId: string
  queryText: string
  provider: string
  location: string | null
  requestedModel?: string | null
}

export type MeasurementUsageEdgeInput =
  | {
      id: string
      type: 'baseline'
      executionId: string
    }
  | {
      id: string
      type: 'target'
      executionId: string
      targetId: string
      /**
       * The frozen class of the assignment behind this edge. It travels with the
       * edge because one question can be Branded for one Property and Non-brand
       * for another. Absent when the revision recorded none.
       */
      queryClass?: MeasurementQueryClass | null
    }

export interface MeasurementObservationInput {
  id: string
  executionId: string | null
  queryText: string
  provider: string
  location: string | null
  answerText: string | null
  /** Live/post-v111 evidence. When non-null this always wins. */
  citedUrls: readonly string[] | null
  citedUrlsComplete: boolean
  /** Offline-only recovery supplied by the caller from stored raw evidence. */
  historicalCitedUrls?: readonly string[]
  historicalCitedUrlsComplete?: boolean
}

export interface MeasurementReportInput {
  revision: number
  ownedHosts: readonly string[]
  /** Revision-pinned project identity. Never derive this from current project state. */
  projectBrandNames: readonly string[]
  /** Revision-pinned canonical project domain for the symmetric SoV output. */
  projectDomain: string
  targets: readonly MeasurementTargetInput[]
  groups: readonly MeasurementGroupInput[]
  expectedSlots: readonly MeasurementExpectedSlotInput[]
  usageEdges: readonly MeasurementUsageEdgeInput[]
  observations: readonly MeasurementObservationInput[]
}

export interface MeasurementAttributionResult {
  classification: MeasurementAttributionClass
  normalizedUrl: string | null
  matchedTargetIds: string[]
  matchedUrlIds: string[]
}

export interface MeasurementAttributionEvidence extends MeasurementAttributionResult {
  observationId: string
  expectedSlotId: string
  executionId: string
  usageEdgeId: string
  usageEdgeType: MeasurementUsageEdgeType
  provider: string
  queryText: string
  location: string | null
  sourceUrl: string
  bridged: boolean
  historical: boolean
  evidenceComplete: boolean
}

export interface MeasurementAnswerSource extends MeasurementAttributionResult {
  sourceUrl: string
}

/**
 * One answer as one Property saw it.
 *
 * A per-URL row can only describe a citation, so an answer that mentioned the
 * Property without linking it, or did neither, produced nothing at all. Emitting
 * per usage edge instead means every measured answer is a row and the URLs nest
 * inside it: `sources` is empty exactly where the gap is.
 *
 * `mentioned` is null when the observation has no answer text to read — a
 * missing signal must never be reported as "not mentioned" — and on a baseline
 * edge, which belongs to no Property for a mention to be about.
 */
export interface MeasurementAnswerEvidence {
  observationId: string
  expectedSlotId: string
  executionId: string
  usageEdgeId: string
  usageEdgeType: MeasurementUsageEdgeType
  provider: string
  queryText: string
  location: string | null
  queryClass: MeasurementQueryClass | null
  mentioned: boolean | null
  cited: boolean | null
  sources: MeasurementAnswerSource[]
  /** The FULL count. A reader may cap `sources`; this never shrinks with it. */
  sourceCount: number
  sourcesTruncated: boolean
  bridged: boolean
  historical: boolean
  evidenceComplete: boolean
}

export type MeasurementRate =
  | { numerator: number; denominator: number; rate: number; reason?: never }
  | { numerator: null; denominator: null; rate: null; reason: MeasurementMetricReason }

export interface MeasurementCompleteness {
  executed: number
  expected: number
  /**
   * Executed observations whose citation capture is complete. This is the exact
   * denominator basis of every source-dependent rate, so a reader can always see
   * how many of the executed observations a coverage rate was computed over.
   * Equal to `executed` when `sourceComplete` is true.
   */
  sourceCompleteObservations: number
  complete: boolean
  sourceComplete: boolean
  answerComplete: boolean
}

export interface MeasurementProviderCoverage {
  provider: string
  completeness: MeasurementCompleteness
  answerCoverage: MeasurementRate
}

export type MeasurementSovDomain =
  | { domain: string; own: boolean; presentIn: number; of: number; reason?: never }
  | { domain: string; own: boolean; presentIn: null; of: null; reason: MeasurementMetricReason }

export interface MeasurementSov {
  /** One frozen project row and one row per competitor domain. */
  domains: MeasurementSovDomain[]
  providers: Array<{ provider: string; domains: MeasurementSovDomain[] }>
}

export interface MeasurementGroupReport {
  id: string
  label: string
  /** Revision-pinned member ids for Target drill-down. */
  targetIds: string[]
  completeness: MeasurementCompleteness
  answerCoverage: MeasurementRate
  targetCoverage: MeasurementRate
  sov: MeasurementSov
  providers: MeasurementProviderCoverage[]
}

export interface MeasurementTargetProviderReport {
  provider: string
  completeness: MeasurementCompleteness
  citationCoverage: MeasurementRate
  mentionCoverage: MeasurementRate
}

export interface MeasurementTargetReport {
  id: string
  label: string
  completeness: MeasurementCompleteness
  citationCoverage: MeasurementRate
  mentionCoverage: MeasurementRate
  providers: MeasurementTargetProviderReport[]
}

export interface MeasurementReport {
  revision: number
  groups: MeasurementGroupReport[]
  targets: MeasurementTargetReport[]
  evidence: MeasurementAttributionEvidence[]
  diagnostics: {
    bridgedObservationIds: string[]
    historicalObservationIds: string[]
    evidenceIncompleteObservationIds: string[]
    ambiguousObservationIds: string[]
    unmatchedObservationIds: string[]
  }
}

/** One comparable name and the revision-pinned aliases it is recognized by. */
export interface MeasurementNamedIdentityInput {
  key: string
  aliases: readonly string[]
}

export interface MeasurementOverviewInput extends MeasurementReportInput {
  /** The Properties this scope selects. Every metric is taken over slots reachable from them. */
  scopeTargetIds: readonly string[]
  /**
   * Identities for the shared-denominator named share. The caller supplies them
   * only where the spec allows one, so the kernel never has to know which scope
   * it is serving.
   */
  namedIdentities?: readonly MeasurementNamedIdentityInput[]
}

export interface MeasurementOverviewPropertyProviderRow {
  provider: string
  mentionCoverage: MeasurementRate
  citationCoverage: MeasurementRate
}

export interface MeasurementOverviewPropertyRow {
  targetId: string
  mentionCoverage: MeasurementRate
  citationCoverage: MeasurementRate
  /**
   * The same two rates taken over each engine's own slots. They are not parts
   * of a whole and never sum to the Property total; an engine with no slot for
   * this Property is absent rather than zero.
   */
  providers: MeasurementOverviewPropertyProviderRow[]
  flags: number
}

export interface MeasurementNamedShareOfVoice {
  /** One shared denominator: the sum of named presence credits, not a slot count. */
  denominator: number
  entries: Array<{ key: string; credits: number; share: number }>
}

export interface MeasurementOverview {
  eligibleSlots: number
  answeredSlots: number
  /** Run-level provenance, independent of whether any recovered source URL produced an evidence row. */
  includesHistoricalData: boolean
  propertiesMentioned: MeasurementRate
  mentionCoverage: MeasurementRate
  citationCoverage: MeasurementRate
  brandPresence: MeasurementRate
  namedShareOfVoice: MeasurementNamedShareOfVoice | null
  properties: MeasurementOverviewPropertyRow[]
  flags: number
}

/** Optional deterministic preparation diagnostics for large frozen reports. */
export interface MeasurementPreparationBuildOptions {
  /** Number of distinct source strings attributed during this one report build. */
  onSourceAttributionComputed?: (uniqueSources: number) => void
}

/**
 * Optional deterministic work hook for callers that need to profile a large
 * overview without using a wall-clock threshold. The callback reports the one
 * pass that builds reusable attribution indexes.
 */
export interface MeasurementOverviewBuildOptions extends MeasurementPreparationBuildOptions {
  onEvidenceIndexed?: (rows: number) => void
}

interface ParsedSourceUrl {
  normalizedUrl: string
  host: string
  path: string
}

/**
 * URL-to-target winners are independent of the usage edge. The edge only
 * decides whether a single winner is assigned to itself or belongs to a
 * sibling. Keeping that split explicit lets one report cache the costly URL
 * parse and target-route scan without altering attribution semantics.
 */
type SourceAttributionClass = Exclude<MeasurementAttributionClass, 'assigned' | 'sibling'> | 'matched'

interface SourceAttribution {
  classification: SourceAttributionClass
  normalizedUrl: string | null
  matchedTargetIds: string[]
  matchedUrlIds: string[]
}

interface RouteClaim {
  targetId: string
  urlId: string
  modeRank: number
  pathLength: number
}

interface PreparedObservation {
  input: MeasurementObservationInput
  slot: MeasurementExpectedSlotInput
  bridged: boolean
  historical: boolean
  sourceComplete: boolean
  sourceUrls: string[]
  mentionedTargetIds: ReadonlySet<string>
}

interface PreparedReport {
  observationsBySlot: ReadonlyMap<string, PreparedObservation>
  answers: MeasurementAnswerEvidence[]
  evidence: MeasurementAttributionEvidence[]
  diagnostics: MeasurementReport['diagnostics']
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function normalizedHost(value: string): string {
  try {
    return normalizeMeasurementHost(value)
  } catch {
    return value.trim().toLocaleLowerCase('en').replace(/\.$/, '').replace(/^www\./, '')
  }
}

function normalizedPath(value: string | undefined): string {
  if (!value) return '/'
  const absolute = value.startsWith('/') ? value : `/${value}`
  let pathname = absolute
  try {
    pathname = new URL(`https://measurement.invalid${absolute}`).pathname
  } catch {
    // An invalid configured matcher simply cannot claim a valid source URL.
  }
  const pieces: string[] = []
  let slash = false
  for (const character of pathname) {
    if (character === '/') {
      if (!slash) pieces.push(character)
      slash = true
    } else {
      pieces.push(character)
      slash = false
    }
  }
  while (pieces.length > 1 && pieces.at(-1) === '/') pieces.pop()
  return pieces.join('') || '/'
}

function parseSourceUrl(value: string): ParsedSourceUrl | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.hash = ''
    const host = normalizedHost(parsed.hostname)
    const path = normalizedPath(parsed.pathname)
    parsed.pathname = path
    return { normalizedUrl: parsed.toString(), host, path }
  } catch {
    return null
  }
}

function ownedBy(host: string, roots: readonly string[]): boolean {
  return roots.some(root => host === root || host.endsWith(`.${root}`))
}

function routeClaim(
  source: ParsedSourceUrl,
  target: MeasurementTargetInput,
  url: MeasurementTargetUrlInput,
): RouteClaim | null {
  if (source.host !== normalizedHost(url.host)) return null
  if (url.mode === 'host') return { targetId: target.id, urlId: url.id, modeRank: 1, pathLength: 0 }

  const configuredPath = normalizedPath(url.path)
  const sourcePath = url.pathCase === 'insensitive'
    ? source.path.toLocaleLowerCase('en')
    : source.path
  const matcherPath = url.pathCase === 'insensitive'
    ? configuredPath.toLocaleLowerCase('en')
    : configuredPath
  const matches = url.mode === 'exact'
    ? sourcePath === matcherPath
    : matcherPath === '/' || sourcePath === matcherPath || sourcePath.startsWith(`${matcherPath}/`)
  if (!matches) return null
  return {
    targetId: target.id,
    urlId: url.id,
    modeRank: url.mode === 'exact' ? 3 : 2,
    pathLength: matcherPath.length,
  }
}

function classifySourceAttribution(
  value: string,
  targets: readonly MeasurementTargetInput[],
  normalizedOwnedHosts: readonly string[],
): SourceAttribution {
  const source = parseSourceUrl(value)
  if (!source) {
    return { classification: 'invalid', normalizedUrl: null, matchedTargetIds: [], matchedUrlIds: [] }
  }

  const claims: RouteClaim[] = []
  for (const target of targets) {
    for (const url of target.urls) {
      const claim = routeClaim(source, target, url)
      if (claim) claims.push(claim)
    }
  }
  claims.sort((left, right) => (
    right.modeRank - left.modeRank
    || right.pathLength - left.pathLength
    || compareText(left.targetId, right.targetId)
    || compareText(left.urlId, right.urlId)
  ))

  const best = claims.at(0)
  if (!best) {
    return {
      classification: ownedBy(source.host, normalizedOwnedHosts) ? 'ownedUnmapped' : 'external',
      normalizedUrl: source.normalizedUrl,
      matchedTargetIds: [],
      matchedUrlIds: [],
    }
  }
  const winners = claims.filter(claim => claim.modeRank === best.modeRank && claim.pathLength === best.pathLength)
  const matchedTargetIds = sortedUnique(winners.map(claim => claim.targetId))
  const matchedUrlIds = sortedUnique(winners.map(claim => claim.urlId))
  if (matchedTargetIds.length !== 1) {
    return { classification: 'ambiguous', normalizedUrl: source.normalizedUrl, matchedTargetIds, matchedUrlIds }
  }

  return {
    classification: 'matched',
    normalizedUrl: source.normalizedUrl,
    matchedTargetIds,
    matchedUrlIds,
  }
}

function classifySourceForUsageEdge(
  source: SourceAttribution,
  usageEdge: MeasurementUsageEdgeInput,
): MeasurementAttributionResult {
  if (source.classification !== 'matched') {
    return {
      classification: source.classification,
      normalizedUrl: source.normalizedUrl,
      matchedTargetIds: source.matchedTargetIds,
      matchedUrlIds: source.matchedUrlIds,
    }
  }
  return {
    classification: usageEdge.type === 'target' && usageEdge.targetId === source.matchedTargetIds[0]
      ? 'assigned'
      : 'sibling',
    normalizedUrl: source.normalizedUrl,
    matchedTargetIds: source.matchedTargetIds,
    matchedUrlIds: source.matchedUrlIds,
  }
}

export function classifyCitedUrl(
  value: string,
  targets: readonly MeasurementTargetInput[],
  ownedHosts: readonly string[],
  usageEdge: MeasurementUsageEdgeInput,
): MeasurementAttributionResult {
  return classifySourceForUsageEdge(
    classifySourceAttribution(value, targets, ownedHosts.map(normalizedHost)),
    usageEdge,
  )
}

export function normalizeMeasurementLocation(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
  return normalized || null
}

function words(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? []
}

/** The exact token identity used when deciding whether two Target aliases are ambiguous. */
export function measurementMentionAliasKey(value: string): string {
  return words(value).join('\u0000')
}

function aliasMatchesAt(textWords: readonly string[], aliasWords: readonly string[], start: number): boolean {
  if (aliasWords.length === 0 || start + aliasWords.length > textWords.length) return false
  for (let index = 0; index < aliasWords.length; index++) {
    if (textWords[start + index] !== aliasWords[index]) return false
  }
  return true
}

function containsAnyAlias(answerText: string, aliases: readonly string[]): boolean {
  const textWords = words(answerText)
  const candidates = aliases.map(words).filter(alias => alias.length > 0)
  for (let start = 0; start < textWords.length; start++) {
    if (candidates.some(alias => aliasMatchesAt(textWords, alias, start))) return true
  }
  return false
}

interface MentionAlias {
  targetId: string
  words: string[]
}

function compiledMentionAliases(targets: readonly MeasurementTargetInput[]): MentionAlias[] {
  return targets.flatMap(target => target.aliases.map(alias => ({ targetId: target.id, words: words(alias) })))
    .filter(alias => alias.words.length > 0)
}

function mentionedTargetsForAliases(
  answerText: string | null,
  aliases: readonly MentionAlias[],
): ReadonlySet<string> {
  const result = new Set<string>()
  if (answerText === null) return result
  const textWords = words(answerText)

  for (let start = 0; start < textWords.length;) {
    const matches = aliases.filter(alias => aliasMatchesAt(textWords, alias.words, start))
    if (matches.length === 0) {
      start++
      continue
    }
    const longest = Math.max(...matches.map(match => match.words.length))
    const owners = sortedUnique(matches.filter(match => match.words.length === longest).map(match => match.targetId))
    if (owners.length === 1) result.add(owners[0]!)
    start += longest
  }
  return result
}

function mentionedTargets(answerText: string | null, targets: readonly MeasurementTargetInput[]): ReadonlySet<string> {
  return mentionedTargetsForAliases(answerText, compiledMentionAliases(targets))
}

/**
 * Target-scoped mention state for a stored answer.
 *
 * This deliberately delegates to the same longest-alias, ambiguity-aware
 * matcher used by report aggregates. A Property detail must not reimplement
 * alias matching and accidentally credit a shared alias to both Properties.
 */
export function targetMentionedInAnswer(
  answerText: string | null,
  targetId: string,
  targets: readonly MeasurementTargetInput[],
): boolean | null {
  if (answerText === null) return null
  return mentionedTargets(answerText, targets).has(targetId)
}

function observationSource(observation: MeasurementObservationInput): {
  urls: string[]
  historical: boolean
  complete: boolean
} {
  if (observation.citedUrls !== null) {
    return {
      urls: sortedUnique(observation.citedUrls),
      historical: false,
      complete: observation.citedUrlsComplete,
    }
  }
  return {
    urls: sortedUnique(observation.historicalCitedUrls ?? []),
    historical: true,
    complete: observation.historicalCitedUrlsComplete === true,
  }
}

function prepareReport(
  input: MeasurementReportInput,
  options: MeasurementPreparationBuildOptions = {},
): PreparedReport {
  const ambiguous = new Set<string>()
  const unmatched = new Set<string>()
  const bridged = new Set<string>()
  const candidates = new Map<string, MeasurementObservationInput[]>()
  // Alias tokenization is definition work, not answer work. A portfolio's
  // frozen aliases are stable for this preparation pass, so compiling them
  // once avoids rescanning hundreds of Property names for every provider
  // answer while preserving the same longest/ambiguous matching algorithm.
  const mentionAliases = compiledMentionAliases(input.targets)

  for (const observation of input.observations) {
    const slots = observation.executionId !== null
      ? input.expectedSlots.filter(slot => slot.executionId === observation.executionId && slot.provider === observation.provider)
      : input.expectedSlots.filter(slot => (
        slot.queryText === observation.queryText
        && slot.provider === observation.provider
        && normalizeMeasurementLocation(slot.location) === normalizeMeasurementLocation(observation.location)
      ))
    if (slots.length === 0) {
      unmatched.add(observation.id)
      continue
    }
    if (slots.length !== 1) {
      ambiguous.add(observation.id)
      continue
    }
    const slot = slots[0]!
    const rows = candidates.get(slot.id) ?? []
    rows.push(observation)
    candidates.set(slot.id, rows)
  }

  const observationsBySlot = new Map<string, PreparedObservation>()
  const historical = new Set<string>()
  const evidenceIncomplete = new Set<string>()
  for (const slot of [...input.expectedSlots].sort((left, right) => compareText(left.id, right.id))) {
    const rows = candidates.get(slot.id) ?? []
    if (rows.length > 1) {
      for (const row of rows) ambiguous.add(row.id)
      continue
    }
    const observation = rows.at(0)
    if (!observation || ambiguous.has(observation.id)) continue
    const source = observationSource(observation)
    const isBridged = observation.executionId === null
    if (isBridged) bridged.add(observation.id)
    if (source.historical) historical.add(observation.id)
    if (!source.complete) evidenceIncomplete.add(observation.id)
    observationsBySlot.set(slot.id, {
      input: observation,
      slot,
      bridged: isBridged,
      historical: source.historical,
      sourceComplete: source.complete,
      sourceUrls: source.urls,
      mentionedTargetIds: mentionedTargetsForAliases(observation.answerText, mentionAliases),
    })
  }

  const edgesByExecution = new Map<string, MeasurementUsageEdgeInput[]>()
  for (const edge of input.usageEdges) {
    const edges = edgesByExecution.get(edge.executionId) ?? []
    edges.push(edge)
    edgesByExecution.set(edge.executionId, edges)
  }

  // One row per (answer, usage edge). A slot with no cited URL at all still
  // produces a row here, which is the only way a Property's gap is visible: the
  // per-URL rows below can describe a citation and nothing else.
  const answers: MeasurementAnswerEvidence[] = []
  // A portfolio can fan one answer out to hundreds of Property edges. Parsing
  // and route-ranking a source per edge turns that normal shape into an
  // O(edges × targets × sources) read. The winners below are edge-independent;
  // only assigned vs sibling is projected per edge.
  const normalizedOwnedHosts = input.ownedHosts.map(normalizedHost)
  const sourceAttributions = new Map<string, SourceAttribution>()
  const sourceAttribution = (sourceUrl: string): SourceAttribution => {
    const cached = sourceAttributions.get(sourceUrl)
    if (cached !== undefined) return cached
    const resolved = classifySourceAttribution(sourceUrl, input.targets, normalizedOwnedHosts)
    sourceAttributions.set(sourceUrl, resolved)
    return resolved
  }
  // Computed once: a Property whose aliases tokenize to nothing can never be
  // mentioned, and the rate path already treats that as unreadable.
  const mentionableIds = new Set(
    mentionAliases.map(alias => alias.targetId),
  )
  for (const observation of observationsBySlot.values()) {
    const edges = [...(edgesByExecution.get(observation.slot.executionId) ?? [])]
      .sort((left, right) => compareText(left.id, right.id))
    for (const edge of edges) {
      const sources = observation.sourceUrls.map(sourceUrl => {
        const { classification, normalizedUrl, matchedTargetIds, matchedUrlIds } =
          classifySourceForUsageEdge(sourceAttribution(sourceUrl), edge)
        return { sourceUrl, normalizedUrl, classification, matchedTargetIds, matchedUrlIds }
      })
      answers.push({
        observationId: observation.input.id,
        expectedSlotId: observation.slot.id,
        executionId: observation.slot.executionId,
        usageEdgeId: edge.id,
        usageEdgeType: edge.type,
        provider: observation.slot.provider,
        queryText: observation.slot.queryText,
        location: observation.slot.location,
        queryClass: edge.type === 'target' ? (edge.queryClass ?? null) : null,
        // Read per Property, because that is the granularity a Property page
        // asks about. Null where there is no signal to read at all: a baseline
        // edge names no Property, and an observation without answer text was
        // never searched — neither is "not mentioned".
        mentioned: mentionedForEdge(observation, edge, mentionableIds),
        // A positive survives incomplete capture: a source we DID see and
        // matched is still a citation. A negative does not — with capture
        // incomplete we cannot tell "not cited" from "we never saw the
        // sources", and reporting the first would be a measured zero.
        cited: sources.some(source => source.classification === 'assigned')
          ? true
          : observation.sourceComplete ? false : null,
        sources,
        sourceCount: sources.length,
        sourcesTruncated: false,
        bridged: observation.bridged,
        historical: observation.historical,
        evidenceComplete: observation.sourceComplete,
      })
    }
  }
  answers.sort((left, right) => (
    compareText(left.expectedSlotId, right.expectedSlotId)
    || compareText(left.usageEdgeId, right.usageEdgeId)
  ))

  // The flat per-URL rows are the published shape, so they are DERIVED from the
  // answer rows rather than built beside them: one source of truth, and the two
  // cannot drift into disagreeing about the same run.
  const evidence: MeasurementAttributionEvidence[] = answers.flatMap(answer => answer.sources.map(source => ({
    observationId: answer.observationId,
    expectedSlotId: answer.expectedSlotId,
    executionId: answer.executionId,
    usageEdgeId: answer.usageEdgeId,
    usageEdgeType: answer.usageEdgeType,
    provider: answer.provider,
    queryText: answer.queryText,
    location: answer.location,
    sourceUrl: source.sourceUrl,
    bridged: answer.bridged,
    historical: answer.historical,
    evidenceComplete: answer.evidenceComplete,
    classification: source.classification,
    normalizedUrl: source.normalizedUrl,
    matchedTargetIds: source.matchedTargetIds,
    matchedUrlIds: source.matchedUrlIds,
  })))
  evidence.sort((left, right) => (
    compareText(left.expectedSlotId, right.expectedSlotId)
    || compareText(left.usageEdgeId, right.usageEdgeId)
    || compareText(left.sourceUrl, right.sourceUrl)
    || compareText(left.classification, right.classification)
  ))

  options.onSourceAttributionComputed?.(sourceAttributions.size)

  return {
    observationsBySlot,
    answers,
    evidence,
    diagnostics: {
      bridgedObservationIds: sortedUnique([...bridged].filter(id => !ambiguous.has(id))),
      historicalObservationIds: sortedUnique([...historical]),
      evidenceIncompleteObservationIds: sortedUnique([...evidenceIncomplete]),
      ambiguousObservationIds: sortedUnique([...ambiguous]),
      unmatchedObservationIds: sortedUnique([...unmatched]),
    },
  }
}

function slotsForEdges(
  expectedSlots: readonly MeasurementExpectedSlotInput[],
  edges: readonly MeasurementUsageEdgeInput[],
): MeasurementExpectedSlotInput[] {
  const executionIds = new Set(edges.map(edge => edge.executionId))
  const slots = new Map<string, MeasurementExpectedSlotInput>()
  for (const slot of expectedSlots) {
    if (executionIds.has(slot.executionId)) slots.set(slot.id, slot)
  }
  return [...slots.values()].sort((left, right) => compareText(left.id, right.id))
}

function completeness(
  slots: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementCompleteness {
  const observations = slots.flatMap(slot => {
    const observation = prepared.observationsBySlot.get(slot.id)
    return observation ? [observation] : []
  })
  const complete = observations.length === slots.length
  const sourceCompleteObservations = observations.filter(observation => observation.sourceComplete).length
  return {
    executed: observations.length,
    expected: slots.length,
    sourceCompleteObservations,
    complete,
    sourceComplete: complete && sourceCompleteObservations === observations.length,
    answerComplete: complete && observations.every(observation => observation.input.answerText !== null),
  }
}

/**
 * Cited URLs come from live web sources, so a fraction of them never resolves and
 * some observations land with partial citation capture. Those rows are not zeros
 * and they are not grounds to refuse the whole population: they simply leave the
 * denominator. Every source-dependent rate is computed over exactly this basis,
 * and `MeasurementCompleteness.sourceCompleteObservations` reports its size.
 */
function sourceCompleteSlots(
  slots: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementExpectedSlotInput[] {
  return slots.filter(slot => prepared.observationsBySlot.get(slot.id)?.sourceComplete === true)
}

function coverageRate(
  slots: readonly MeasurementExpectedSlotInput[],
  edges: readonly MeasurementUsageEdgeInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const status = completeness(slots, prepared)
  if (slots.length === 0) return { numerator: null, denominator: null, rate: null, reason: 'no-population' }
  if (!status.complete) return { numerator: null, denominator: null, rate: null, reason: 'incomplete' }

  const basis = sourceCompleteSlots(slots, prepared)
  if (basis.length === 0) return { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }

  const edgeIds = new Set(edges.map(edge => edge.id))
  const assignedSlots = new Set(prepared.evidence
    .filter(row => edgeIds.has(row.usageEdgeId) && row.classification === 'assigned')
    .map(row => row.expectedSlotId))
  const numerator = basis.filter(slot => assignedSlots.has(slot.id)).length
  return { numerator, denominator: basis.length, rate: numerator / basis.length }
}

function targetCoverageRate(
  targetIds: readonly string[],
  slots: readonly MeasurementExpectedSlotInput[],
  edges: readonly MeasurementUsageEdgeInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const status = completeness(slots, prepared)
  const denominator = sortedUnique(targetIds).length
  if (denominator === 0 || slots.length === 0) return { numerator: null, denominator: null, rate: null, reason: 'no-population' }
  if (!status.complete) return { numerator: null, denominator: null, rate: null, reason: 'incomplete' }

  const basis = new Set(sourceCompleteSlots(slots, prepared).map(slot => slot.id))
  if (basis.size === 0) return { numerator: null, denominator: null, rate: null, reason: 'evidence-incomplete' }

  const edgeIds = new Set(edges.map(edge => edge.id))
  // A target cited only by a partially captured observation cannot count here: its
  // evidence sits outside the basis the rate is reported over.
  const citedTargets = new Set(prepared.evidence
    .filter(row => edgeIds.has(row.usageEdgeId) && row.classification === 'assigned' && basis.has(row.expectedSlotId))
    .flatMap(row => row.matchedTargetIds))
  const numerator = sortedUnique(targetIds).filter(id => citedTargets.has(id)).length
  return { numerator, denominator, rate: numerator / denominator }
}

function mentionRate(
  target: MeasurementTargetInput,
  slots: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const numerator = slots.filter(slot => prepared.observationsBySlot.get(slot.id)?.mentionedTargetIds.has(target.id)).length
  if (target.aliases.every(alias => words(alias).length === 0)) {
    return { numerator: null, denominator: null, rate: null, reason: 'aliasless' }
  }
  if (slots.length === 0) return { numerator: null, denominator: null, rate: null, reason: 'no-population' }
  const status = completeness(slots, prepared)
  if (!status.complete || !status.answerComplete) {
    return { numerator: null, denominator: null, rate: null, reason: 'incomplete' }
  }
  return { numerator, denominator: slots.length, rate: numerator / slots.length }
}

function providersFor(slots: readonly MeasurementExpectedSlotInput[]): string[] {
  return sortedUnique(slots.map(slot => slot.provider))
}

function buildSovForSlots(
  slots: readonly MeasurementExpectedSlotInput[],
  competitors: readonly MeasurementCompetitorInput[],
  projectBrandNames: readonly string[],
  projectDomain: string,
  prepared: PreparedReport,
): MeasurementSov {
  const sortedCompetitors = [...competitors].sort((left, right) => compareText(left.domain, right.domain))
  const rows = [
    { domain: projectDomain, own: true, aliases: projectBrandNames },
    ...sortedCompetitors.map(competitor => ({
      domain: competitor.domain,
      own: false,
      aliases: competitor.aliases,
    })),
  ]

  const calculate = (selected: readonly MeasurementExpectedSlotInput[]): MeasurementSovDomain[] => {
    const status = completeness(selected, prepared)
    let reason: MeasurementMetricReason | null = null
    if (selected.length === 0) reason = 'no-population'
    else if (!status.complete || !status.answerComplete) reason = 'incomplete'
    else if (projectBrandNames.every(alias => words(alias).length === 0)) reason = 'no-project-aliases'
    else if (sortedCompetitors.length === 0) reason = 'no-competitors'

    return rows.map(row => {
      if (reason !== null) return { domain: row.domain, own: row.own, presentIn: null, of: null, reason }
      if (row.aliases.every(alias => words(alias).length === 0)) {
        return { domain: row.domain, own: row.own, presentIn: null, of: null, reason: 'aliasless' }
      }
      const presentIn = selected.filter(slot => {
        const answer = prepared.observationsBySlot.get(slot.id)?.input.answerText
        return answer !== null && answer !== undefined && containsAnyAlias(answer, row.aliases)
      }).length
      return { domain: row.domain, own: row.own, presentIn, of: selected.length }
    })
  }

  return {
    domains: calculate(slots),
    providers: providersFor(slots).map(provider => ({
      provider,
      domains: calculate(slots.filter(slot => slot.provider === provider)),
    })),
  }
}

function buildGroupReport(
  group: MeasurementGroupInput,
  input: MeasurementReportInput,
  prepared: PreparedReport,
): MeasurementGroupReport {
  const targetIds = new Set(group.targetIds)
  // Groups are reporting lenses only. Their population is the unique slot set
  // reached by member target edges; shared executions are counted once.
  const edges = input.usageEdges.filter((edge): edge is Extract<MeasurementUsageEdgeInput, { type: 'target' }> => (
    edge.type === 'target' && targetIds.has(edge.targetId)
  ))
  const slots = slotsForEdges(input.expectedSlots, edges)
  return {
    id: group.id,
    label: group.label,
    targetIds: sortedUnique(group.targetIds),
    completeness: completeness(slots, prepared),
    answerCoverage: coverageRate(slots, edges, prepared),
    targetCoverage: targetCoverageRate(group.targetIds, slots, edges, prepared),
    sov: buildSovForSlots(slots, group.competitors, input.projectBrandNames, input.projectDomain, prepared),
    providers: providersFor(slots).map(provider => {
      const providerSlots = slots.filter(slot => slot.provider === provider)
      return {
        provider,
        completeness: completeness(providerSlots, prepared),
        answerCoverage: coverageRate(providerSlots, edges, prepared),
      }
    }),
  }
}

function buildTargetReport(
  target: MeasurementTargetInput,
  input: MeasurementReportInput,
  prepared: PreparedReport,
): MeasurementTargetReport {
  const edges = input.usageEdges.filter((edge): edge is Extract<MeasurementUsageEdgeInput, { type: 'target' }> => (
    edge.type === 'target' && edge.targetId === target.id
  ))
  const slots = slotsForEdges(input.expectedSlots, edges)
  return {
    id: target.id,
    label: target.label,
    completeness: completeness(slots, prepared),
    citationCoverage: coverageRate(slots, edges, prepared),
    mentionCoverage: mentionRate(target, slots, prepared),
    providers: providersFor(slots).map(provider => {
      const providerSlots = slots.filter(slot => slot.provider === provider)
      return {
        provider,
        completeness: completeness(providerSlots, prepared),
        citationCoverage: coverageRate(providerSlots, edges, prepared),
        mentionCoverage: mentionRate(target, providerSlots, prepared),
      }
    }),
  }
}

function unavailable(reason: MeasurementMetricReason): MeasurementRate {
  return { numerator: null, denominator: null, rate: null, reason }
}

type MeasurementTargetUsageEdge = Extract<MeasurementUsageEdgeInput, { type: 'target' }>

/**
 * Every per-Property calculation shares this projection of a prepared run.
 * In particular, attribution evidence is read once here rather than once for
 * every Target in the scoped Property list.
 */
interface MeasurementOverviewIndexes {
  targetsById: ReadonlyMap<string, readonly MeasurementTargetInput[]>
  targetEdgesByTargetId: ReadonlyMap<string, readonly MeasurementTargetUsageEdge[]>
  slotsByExecutionId: ReadonlyMap<string, readonly MeasurementExpectedSlotInput[]>
  answeredSlotIds: ReadonlySet<string>
  sourceCompleteSlotIds: ReadonlySet<string>
  mentionedSlotIdsByTargetId: ReadonlyMap<string, ReadonlySet<string>>
  assignedSlotIdsByEdgeId: ReadonlyMap<string, ReadonlySet<string>>
  ambiguousEvidenceKeysByTargetId: ReadonlyMap<string, ReadonlySet<string>>
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>()
  values.add(value)
  map.set(key, values)
}

function buildMeasurementOverviewIndexes(
  input: MeasurementOverviewInput,
  prepared: PreparedReport,
  onEvidenceIndexed: MeasurementOverviewBuildOptions['onEvidenceIndexed'],
): MeasurementOverviewIndexes {
  const targetsById = new Map<string, MeasurementTargetInput[]>()
  for (const target of input.targets) {
    const targets = targetsById.get(target.id) ?? []
    targets.push(target)
    targetsById.set(target.id, targets)
  }
  const targetEdgesByTargetId = new Map<string, MeasurementTargetUsageEdge[]>()
  const targetIdByEdgeId = new Map<string, string>()
  for (const edge of input.usageEdges) {
    if (edge.type !== 'target') continue
    const edges = targetEdgesByTargetId.get(edge.targetId) ?? []
    edges.push(edge)
    targetEdgesByTargetId.set(edge.targetId, edges)
    targetIdByEdgeId.set(edge.id, edge.targetId)
  }

  const slotsByExecutionId = new Map<string, MeasurementExpectedSlotInput[]>()
  for (const slot of input.expectedSlots) {
    const slots = slotsByExecutionId.get(slot.executionId) ?? []
    slots.push(slot)
    slotsByExecutionId.set(slot.executionId, slots)
  }

  const answeredSlotIds = new Set<string>()
  const sourceCompleteSlotIds = new Set<string>()
  const mentionedSlotIdsByTargetId = new Map<string, Set<string>>()
  for (const [slotId, observation] of prepared.observationsBySlot) {
    if (observation.sourceComplete) sourceCompleteSlotIds.add(slotId)
    if (observation.input.answerText === null) continue
    answeredSlotIds.add(slotId)
    for (const targetId of observation.mentionedTargetIds) {
      addToSet(mentionedSlotIdsByTargetId, targetId, slotId)
    }
  }

  const assignedSlotIdsByEdgeId = new Map<string, Set<string>>()
  const ambiguousEvidenceKeysByTargetId = new Map<string, Set<string>>()
  let evidenceRowsIndexed = 0
  for (const row of prepared.evidence) {
    evidenceRowsIndexed++
    if (row.classification === 'assigned') {
      addToSet(assignedSlotIdsByEdgeId, row.usageEdgeId, row.expectedSlotId)
      continue
    }
    if (row.classification !== 'ambiguous') continue

    // An ambiguity belongs to the Property whose own usage edge produced this
    // row. A sibling's edge gets its own row and its own indexed flag.
    const targetId = targetIdByEdgeId.get(row.usageEdgeId)
    if (targetId !== undefined && row.matchedTargetIds.includes(targetId)) {
      addToSet(ambiguousEvidenceKeysByTargetId, targetId, `${row.expectedSlotId}\u0000${row.sourceUrl}`)
    }
  }
  onEvidenceIndexed?.(evidenceRowsIndexed)

  return {
    targetsById,
    targetEdgesByTargetId,
    slotsByExecutionId,
    answeredSlotIds,
    sourceCompleteSlotIds,
    mentionedSlotIdsByTargetId,
    assignedSlotIdsByEdgeId,
    ambiguousEvidenceKeysByTargetId,
  }
}

function indexedScopeEdges(
  indexes: MeasurementOverviewIndexes,
  targetIds: ReadonlySet<string>,
): MeasurementTargetUsageEdge[] {
  const edges: MeasurementTargetUsageEdge[] = []
  for (const targetId of targetIds) edges.push(...(indexes.targetEdgesByTargetId.get(targetId) ?? []))
  return edges
}

function indexedSlotsForEdges(
  edges: readonly MeasurementUsageEdgeInput[],
  indexes: MeasurementOverviewIndexes,
): MeasurementExpectedSlotInput[] {
  const slots = new Map<string, MeasurementExpectedSlotInput>()
  for (const edge of edges) {
    for (const slot of indexes.slotsByExecutionId.get(edge.executionId) ?? []) slots.set(slot.id, slot)
  }
  return [...slots.values()].sort((left, right) => compareText(left.id, right.id))
}

/**
 * Slots whose answer text actually landed. Every answer-dependent overview rate
 * is taken over these rather than over the whole expected population: a run that
 * answered half its slots has measured half, not zero.
 */
function indexedAnsweredSlots(
  slots: readonly MeasurementExpectedSlotInput[],
  indexes: MeasurementOverviewIndexes,
): MeasurementExpectedSlotInput[] {
  return slots.filter(slot => indexes.answeredSlotIds.has(slot.id))
}

/**
 * Mention is unreadable, not absent, in three cases: a baseline edge names no
 * Property for a mention to be about; an observation with no answer text was
 * never searched; and a Property whose aliases tokenize to nothing can never
 * match, which the rate path already reports as `aliasless`. Returning false
 * for any of them states a measured negative the run does not support.
 */
function mentionedForEdge(
  observation: PreparedObservation,
  edge: MeasurementUsageEdgeInput,
  mentionableIds: ReadonlySet<string>,
): boolean | null {
  if (edge.type !== 'target') return null
  if (observation.input.answerText === null) return null
  if (!mentionableIds.has(edge.targetId)) return null
  return observation.mentionedTargetIds.has(edge.targetId)
}

function mentionableTargets(
  input: MeasurementOverviewInput,
  targetIds: ReadonlySet<string>,
): MeasurementTargetInput[] {
  return input.targets.filter(target => (
    targetIds.has(target.id) && target.aliases.some(alias => words(alias).length > 0)
  ))
}

function scopeMentionRate(
  input: MeasurementOverviewInput,
  targetIds: ReadonlySet<string>,
  slots: readonly MeasurementExpectedSlotInput[],
  answered: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const mentionable = mentionableTargets(input, targetIds)
  if (mentionable.length === 0) return unavailable('aliasless')
  if (slots.length === 0) return unavailable('no-population')
  if (answered.length === 0) return unavailable('evidence-incomplete')

  const ids = mentionable.map(target => target.id)
  const numerator = answered.filter(slot => {
    const mentioned = prepared.observationsBySlot.get(slot.id)?.mentionedTargetIds
    return mentioned !== undefined && ids.some(id => mentioned.has(id))
  }).length
  return { numerator, denominator: answered.length, rate: numerator / answered.length }
}

function indexedScopeCitationRate(
  slots: readonly MeasurementExpectedSlotInput[],
  edges: readonly MeasurementUsageEdgeInput[],
  indexes: MeasurementOverviewIndexes,
): MeasurementRate {
  if (slots.length === 0) return unavailable('no-population')
  const basis = slots.filter(slot => indexes.sourceCompleteSlotIds.has(slot.id))
  if (basis.length === 0) return unavailable('evidence-incomplete')

  const assignedSlots = new Set<string>()
  for (const edge of edges) {
    for (const slotId of indexes.assignedSlotIdsByEdgeId.get(edge.id) ?? []) assignedSlots.add(slotId)
  }
  const numerator = basis.filter(slot => assignedSlots.has(slot.id)).length
  return { numerator, denominator: basis.length, rate: numerator / basis.length }
}

function targetMentionRate(
  targets: readonly MeasurementTargetInput[] | undefined,
  slots: readonly MeasurementExpectedSlotInput[],
  answered: readonly MeasurementExpectedSlotInput[],
  indexes: MeasurementOverviewIndexes,
): MeasurementRate {
  const mentionable = targets?.filter(target => target.aliases.some(alias => words(alias).length > 0)) ?? []
  if (mentionable.length === 0) return unavailable('aliasless')
  if (slots.length === 0) return unavailable('no-population')
  if (answered.length === 0) return unavailable('evidence-incomplete')

  const mentioned = indexes.mentionedSlotIdsByTargetId.get(mentionable[0]!.id) ?? new Set<string>()
  const numerator = answered.filter(slot => mentioned.has(slot.id)).length
  return { numerator, denominator: answered.length, rate: numerator / answered.length }
}

function presenceIn(
  slots: readonly MeasurementExpectedSlotInput[],
  aliases: readonly string[],
  prepared: PreparedReport,
): number {
  return slots.filter(slot => {
    const answer = prepared.observationsBySlot.get(slot.id)?.input.answerText
    return answer !== null && answer !== undefined && containsAnyAlias(answer, aliases)
  }).length
}

/**
 * Independent identity presence, never a share of anything. Nobody else's
 * appearance moves this number, which is exactly what separates it from the
 * shared-denominator named share below.
 */
function scopeBrandPresence(
  input: MeasurementOverviewInput,
  slots: readonly MeasurementExpectedSlotInput[],
  answered: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementRate {
  if (slots.length === 0) return unavailable('no-population')
  if (input.projectBrandNames.every(alias => words(alias).length === 0)) return unavailable('no-project-aliases')
  if (answered.length === 0) return unavailable('evidence-incomplete')

  const numerator = presenceIn(answered, input.projectBrandNames, prepared)
  return { numerator, denominator: answered.length, rate: numerator / answered.length }
}

function scopePropertiesMentioned(
  input: MeasurementOverviewInput,
  targetIds: ReadonlySet<string>,
  slots: readonly MeasurementExpectedSlotInput[],
  answered: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementRate {
  const mentionable = mentionableTargets(input, targetIds)
  if (mentionable.length === 0) return unavailable('aliasless')
  if (slots.length === 0) return unavailable('no-population')
  if (answered.length === 0) return unavailable('evidence-incomplete')

  const mentioned = new Set(answered.flatMap(slot => (
    [...(prepared.observationsBySlot.get(slot.id)?.mentionedTargetIds ?? [])]
  )))
  const numerator = mentionable.filter(target => mentioned.has(target.id)).length
  return { numerator, denominator: mentionable.length, rate: numerator / mentionable.length }
}

function scopeNamedShareOfVoice(
  identities: readonly MeasurementNamedIdentityInput[],
  answered: readonly MeasurementExpectedSlotInput[],
  prepared: PreparedReport,
): MeasurementNamedShareOfVoice | null {
  if (identities.length === 0 || answered.length === 0) return null

  const credited = identities.map(identity => ({
    key: identity.key,
    credits: presenceIn(answered, identity.aliases, prepared),
  }))
  // One answer may name several identities, so this sums credits rather than
  // slots. A denominator of zero is no share at all, not a row of zeroes.
  const denominator = credited.reduce((total, row) => total + row.credits, 0)
  if (denominator === 0) return null
  return {
    denominator,
    entries: credited.map(row => ({ ...row, share: row.credits / denominator })),
  }
}

/**
 * Scoped aggregate over one run's evidence.
 *
 * The caller narrows `expectedSlots` and `usageEdges` before calling — that is
 * how the provider, location and question-class filters are applied — so the
 * kernel only has to reach the unique slots the selected Properties share. Two
 * Properties reusing one execution contribute one slot, never two.
 */
export function buildMeasurementOverview(
  input: MeasurementOverviewInput,
  options: MeasurementOverviewBuildOptions = {},
): MeasurementOverview {
  const prepared = prepareReport(input, options)
  const indexes = buildMeasurementOverviewIndexes(input, prepared, options.onEvidenceIndexed)
  const targetIds = new Set(input.scopeTargetIds)
  const edges = indexedScopeEdges(indexes, targetIds)
  const slots = indexedSlotsForEdges(edges, indexes)
  const answered = indexedAnsweredSlots(slots, indexes)

  const properties = sortedUnique([...targetIds]).map(targetId => {
    const ownEdges = indexes.targetEdgesByTargetId.get(targetId) ?? []
    const ownSlots = indexedSlotsForEdges(ownEdges, indexes)
    const ownAnswered = indexedAnsweredSlots(ownSlots, indexes)
    const ownTargets = indexes.targetsById.get(targetId)
    return {
      targetId,
      mentionCoverage: targetMentionRate(ownTargets, ownSlots, ownAnswered, indexes),
      citationCoverage: indexedScopeCitationRate(ownSlots, ownEdges, indexes),
      // Each engine is measured over the slots it owns, using exactly the
      // functions the Property total uses. A per-engine reading is therefore
      // withheld for the same reasons the total is, never rounded down to zero.
      providers: providersFor(ownSlots).map(provider => {
        const providerSlots = ownSlots.filter(slot => slot.provider === provider)
        return {
          provider,
          mentionCoverage: targetMentionRate(
            ownTargets,
            providerSlots,
            indexedAnsweredSlots(providerSlots, indexes),
            indexes,
          ),
          citationCoverage: indexedScopeCitationRate(providerSlots, ownEdges, indexes),
        }
      }),
      flags: indexes.ambiguousEvidenceKeysByTargetId.get(targetId)?.size ?? 0,
    }
  })

  return {
    eligibleSlots: slots.length,
    answeredSlots: answered.length,
    includesHistoricalData: prepared.diagnostics.bridgedObservationIds.length > 0
      || prepared.diagnostics.historicalObservationIds.length > 0,
    propertiesMentioned: scopePropertiesMentioned(input, targetIds, slots, answered, prepared),
    mentionCoverage: scopeMentionRate(input, targetIds, slots, answered, prepared),
    citationCoverage: indexedScopeCitationRate(slots, edges, indexes),
    brandPresence: scopeBrandPresence(input, slots, answered, prepared),
    namedShareOfVoice: scopeNamedShareOfVoice(input.namedIdentities ?? [], answered, prepared),
    properties,
    flags: properties.reduce((total, row) => total + row.flags, 0),
  }
}

export interface MeasurementEvidenceResult {
  /** One row per (answer, usage edge), including the answers that cited nobody. */
  answers: MeasurementAnswerEvidence[]
  evidence: MeasurementAttributionEvidence[]
  diagnostics: MeasurementReport['diagnostics']
}

/**
 * Attribution evidence without the group and Target roll-ups.
 *
 * A caller that only needs the rows for one Property would otherwise build
 * every group report and every Target report to reach them. The rows are
 * identical to `buildMeasurementReport(input).evidence` — same preparation,
 * same deterministic order — so the two reads can never disagree.
 */
export function buildMeasurementEvidence(
  input: MeasurementReportInput,
  options: MeasurementPreparationBuildOptions = {},
): MeasurementEvidenceResult {
  const prepared = prepareReport(input, options)
  return { answers: prepared.answers, evidence: prepared.evidence, diagnostics: prepared.diagnostics }
}

export function buildMeasurementReport(
  input: MeasurementReportInput,
  options: MeasurementPreparationBuildOptions = {},
): MeasurementReport {
  const prepared = prepareReport(input, options)
  return {
    revision: input.revision,
    groups: [...input.groups]
      .sort((left, right) => compareText(left.id, right.id))
      .map(group => buildGroupReport(group, input, prepared)),
    targets: [...input.targets]
      .sort((left, right) => compareText(left.id, right.id))
      .map(target => buildTargetReport(target, input, prepared)),
    evidence: prepared.evidence,
    diagnostics: prepared.diagnostics,
  }
}
