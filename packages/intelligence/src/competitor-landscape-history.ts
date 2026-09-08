import {
  brandKeyFromText,
  brandLabelFromDomain,
  compileBrandAliases,
  hostMatchesAnyDomain,
  hostOf,
  matchedAliasKeys,
  MIN_DOMAIN_BRAND_KEY_LENGTH,
  registrableDomain,
  type BrandAliasMatcher,
  type ShareOfVoiceContext,
} from '@ainyc/canonry-contracts'
import { MIN_BRAND_ALIAS_KEY_LENGTH } from './mention-share.js'
import { buildShareOfVoiceFrame } from './share-of-voice-frame.js'

/** A stored discovery classification, plus the explicit unknown state. */
export type CompetitorLandscapeSurfaceClass =
  | 'direct-competitor'
  | 'ota-aggregator'
  | 'editorial-media'
  | 'other'
  | 'unknown'

export interface CompetitorLandscapeHistorySnapshot {
  id: string
  createdAt: string
  /** Null/empty means this result cannot contribute to a mention denominator. */
  answerText: string | null
  /** Already resolved from the project identity by the DB/API layer. */
  projectMentioned: boolean
  /** Provider-extracted source hosts. This remains useful before URL capture. */
  citedDomains: readonly string[]
  /** Captured source URLs. Null means the row predates URL capture. */
  citedUrls: readonly string[] | null
  /** Advanced competitors frozen into this snapshot's run revision only. */
  frozenCompetitors?: readonly CompetitorLandscapeIdentity[]
}

export interface CompetitorLandscapeIdentity {
  domain: string
  label: string
  /** Generated display labels are not operator-approved brand aliases. */
  labelSource?: 'domain' | 'curated'
  /** Curated frozen aliases (Advanced Measurement) supplement the display label. */
  aliases?: readonly string[]
}

export interface CompetitorLandscapeProjectIdentity extends CompetitorLandscapeIdentity {
  /** Every owned host, including the canonical host. */
  domains: readonly string[]
}

export interface CompetitorLandscapeHistoryOptions {
  project: CompetitorLandscapeProjectIdentity
  /** Explicit user-managed competitors. They always remain visible. */
  pinned: readonly CompetitorLandscapeIdentity[]
  /** Discovery's persisted exact-host type. This read never invokes discovery/LLM work. */
  classifications: ReadonlyMap<string, CompetitorLandscapeSurfaceClass>
  snapshots: readonly CompetitorLandscapeHistorySnapshot[]
  /**
   * May a share of voice be published for this selection?
   *
   * Share of voice is a ratio over a denominator, so it is only meaningful
   * when every result in it answers the same kind of query. A brand wins its
   * own branded queries almost by definition, so pooling branded and
   * non-brand results inflates the brand and deflates every competitor: on
   * real stored evidence one project reads 43.8% pooled against 3.6% on
   * non-brand alone. Callers that cannot scope to a single class must publish
   * the counts and omit the ratio rather than pass a pooled basket off as a
   * competitive figure.
   */
  shareOfVoiceEligible: boolean
  /** Capped evidence samples keep the response bounded. */
  sampleUrlLimit?: number
}

export interface CompetitorLandscapeHistoryRow {
  domain: string
  label: string
  surfaceClass: CompetitorLandscapeSurfaceClass | 'own'
  pinned: boolean
  /** One mention credit at most per answer. */
  mentionCount: number
  /**
   * Percentage points (0..100). Null outside the competitive denominator, and
   * null whenever the selection pools query classes.
   */
  shareOfVoice: number | null
  /** One source credit at most per answer. Independent from mentionCount. */
  citationCount: number
  /** The number of answer-text results behind this row's mention field. */
  answeredResults: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  sampleUrls: string[]
}

export interface CompetitorLandscapeHistoryEvidence {
  /** Results with answer prose; the only valid mention denominator. */
  answeredResults: number
  /** Results carrying any source-domain or source-URL evidence. */
  sourceResults: number
  /** Historical rows with source evidence but no answer prose. */
  missingAnswerTextResults: number
  /** Sum of project + direct-competitor brand credits, not a unique-result count. */
  mentionCredits: number
}

export interface CompetitorLandscapeHistoryResult extends ShareOfVoiceContext {
  comparison: Array<{ domain: string; mentions: number }>
  project: CompetitorLandscapeHistoryRow
  pinned: CompetitorLandscapeHistoryRow[]
  observed: CompetitorLandscapeHistoryRow[]
  otherSources: CompetitorLandscapeHistoryRow[]
  evidence: CompetitorLandscapeHistoryEvidence
}

interface MutableRow {
  identity: CompetitorLandscapeIdentity
  surfaceClass: CompetitorLandscapeHistoryRow['surfaceClass']
  pinned: boolean
  mentionCount: number
  citationCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  sampleUrls: Set<string>
}

interface Candidate {
  domain: string
  label: string
  labelSource: 'domain' | 'curated'
  aliases: readonly string[]
  surfaceClass: CompetitorLandscapeSurfaceClass
  pinned: boolean
  matcher: BrandAliasMatcher
}

/**
 * A read-time historical competitor landscape. It deliberately has no database
 * or provider dependency: callers supply only persisted answer/source evidence.
 * Pinning therefore recomputes older history immediately without a new sweep.
 */
export function buildCompetitorLandscapeHistory(
  options: CompetitorLandscapeHistoryOptions,
): CompetitorLandscapeHistoryResult {
  const sampleUrlLimit = options.sampleUrlLimit ?? 3
  const projectDomain = hostOf(options.project.domain) ?? options.project.domain
  // Ownership is an exact-host/subdomain boundary. Reducing an owned host to
  // eTLD+1 first would claim its parent and every sibling as project evidence.
  const projectDomains = normalizedHosts([projectDomain, ...options.project.domains])
  const pinned = new Map<string, Candidate>()
  for (const identity of options.pinned) {
    const domain = normalizeDomain(identity.domain)
    if (!domain || hostMatchesAnyDomain(identity.domain, projectDomains)) continue
    putCandidate(pinned, candidateFor({
      domain,
      label: identity.label,
      labelSource: identity.labelSource,
      aliases: identity.aliases,
      pinned: true,
      surfaceClass: 'direct-competitor',
    }))
  }

  // Known direct identities are candidates before source evidence is inspected:
  // a stored discovery classification or frozen market competitor can be named
  // in answer prose without being cited. We suppress zero-activity observed rows
  // when finalizing, while pins deliberately remain visible at zero.
  const groupedClassifications = groupClassifications(new Map(
    [...options.classifications].filter(([host]) => !hostMatchesAnyDomain(host, projectDomains)),
  ))
  const classifiedDirect = new Map<string, Candidate>()
  for (const [domain, surfaceClass] of groupedClassifications) {
    if (surfaceClass !== 'direct-competitor' || hostMatchesAnyDomain(domain, projectDomains) || pinned.has(domain)) continue
    putCandidate(classifiedDirect, candidateFor({
      domain,
      label: brandLabelFromDomain(domain) || domain,
      labelSource: 'domain',
      pinned: false,
      surfaceClass,
    }))
  }

  const observed = new Map<string, Candidate>(classifiedDirect)
  const others = new Map<string, Candidate>()
  const frozenBySnapshot = new Map<string, Map<string, Candidate>>()
  for (const snapshot of options.snapshots) {
    const frozen = new Map<string, Candidate>()
    for (const identity of snapshot.frozenCompetitors ?? []) {
      const domain = normalizeDomain(identity.domain)
      if (!domain || hostMatchesAnyDomain(identity.domain, projectDomains)) continue
      const candidate = candidateFor({
        domain,
        label: identity.label,
        labelSource: identity.labelSource,
        aliases: identity.aliases,
        pinned: false,
        surfaceClass: 'direct-competitor',
      })
      putCandidate(frozen, candidate)
      if (!pinned.has(domain)) putCandidate(observed, candidate)
    }
    if (frozen.size > 0) frozenBySnapshot.set(snapshot.id, frozen)
  }
  for (const snapshot of options.snapshots) {
    for (const source of sourcesOf(snapshot)) {
      const domain = normalizeDomain(source)
      if (!domain || hostMatchesAnyDomain(source, projectDomains) || pinned.has(domain)) continue
      // Frozen/direct candidates already own this domain. A missing discovery
      // classification must not demote their citation into otherSources.
      if (observed.has(domain)) continue
      const surfaceClass = surfaceClassForSource(source, domain, options.classifications, groupedClassifications)
      const candidate = candidateFor({
        domain,
        label: brandLabelFromDomain(domain) || domain,
        labelSource: 'domain',
        pinned: false,
        surfaceClass,
      })
      if (surfaceClass === 'direct-competitor') {
        putCandidate(classifiedDirect, candidate)
        putCandidate(observed, candidate)
      } else {
        putCandidate(others, candidate)
      }
    }
  }

  const rows = new Map<string, MutableRow>()
  const projectRow = emptyRow({ domain: projectDomain, label: options.project.label }, 'own', false)
  const candidateRows = new Map<string, MutableRow>()
  for (const candidate of [...pinned.values(), ...observed.values(), ...others.values()]) {
    const row = emptyRow(candidate, candidate.surfaceClass, candidate.pinned)
    rows.set(candidate.domain, row)
    candidateRows.set(candidate.domain, row)
  }

  let answeredResults = 0
  let sourceResults = 0
  let missingAnswerTextResults = 0

  const baseEligible = new Map<string, Candidate>()
  for (const candidate of [...pinned.values(), ...classifiedDirect.values()]) {
    putCandidate(baseEligible, candidate)
  }
  const baseCombined = combineMatchers([...baseEligible.values()].map(candidate => candidate.matcher))
  const candidateRowsByHost = new Map<string, Array<[string, MutableRow]>>()
  for (const [domain, row] of candidateRows) {
    const host = hostOf(domain)
    if (!host) continue
    const bucket = candidateRowsByHost.get(host)
    if (bucket) bucket.push([domain, row])
    else candidateRowsByHost.set(host, [[domain, row]])
  }

  for (const snapshot of options.snapshots) {
    const text = snapshot.answerText?.trim() ?? ''
    const sources = sourcesOf(snapshot)
    if (sources.length > 0) sourceResults++
    if (text === '' && sources.length > 0) missingAnswerTextResults++

    if (text !== '') {
      answeredResults++
      if (snapshot.projectMentioned) recordMention(projectRow, snapshot.createdAt)
      // One segmentation of the answer for the whole eligible set, then a key
      // lookup per candidate. Matching each candidate separately re-normalized
      // the full answer once per competitor per snapshot.
      const frozen = frozenBySnapshot.get(snapshot.id)
      let eligibleCandidates = baseEligible
      let combined = baseCombined
      if (frozen) {
        eligibleCandidates = new Map(baseEligible)
        for (const candidate of frozen.values()) putCandidate(eligibleCandidates, candidate)
        combined = combineMatchers([...eligibleCandidates.values()].map(candidate => candidate.matcher))
      }
      const matchedKeys = matchedAliasKeys(combined, text)
      if (matchedKeys.size > 0) {
        for (const candidate of eligibleCandidates.values()) {
          for (const key of candidate.matcher.keys) {
            if (!matchedKeys.has(key)) continue
            recordMention(candidateRows.get(candidate.domain)!, snapshot.createdAt)
            break
          }
        }
      }
    }

    // Citation evidence is source-list evidence. It is intentionally processed
    // whether or not answer text exists, so an old/source-only row never loses
    // a truthful citation just because it is unusable for mention share.
    const seenCitationDomains = new Set<string>()
    for (const source of sources) {
      const normalized = normalizeDomain(source)
      if (!normalized) continue
      if (hostMatchesAnyDomain(source, projectDomains)) {
        if (!seenCitationDomains.has(projectDomain)) {
          seenCitationDomains.add(projectDomain)
          recordCitation(projectRow, snapshot.createdAt, source, sampleUrlLimit)
        } else {
          recordSampleUrl(projectRow, source, sampleUrlLimit)
        }
        continue
      }
      // Same rule as hostMatchesDomain (equal host or a subdomain of it), but
      // resolved by looking up each label suffix of the source host instead of
      // re-parsing every candidate domain for every source.
      const sourceHost = hostOf(normalized)
      if (!sourceHost) continue
      for (const suffix of hostSuffixes(sourceHost)) {
        for (const [domain, row] of candidateRowsByHost.get(suffix) ?? []) {
          if (seenCitationDomains.has(domain)) {
            recordSampleUrl(row, source, sampleUrlLimit)
            continue
          }
          seenCitationDomains.add(domain)
          recordCitation(row, snapshot.createdAt, source, sampleUrlLimit)
        }
      }
    }
  }

  // Pins are the operator's comparison set. Observed identities are a fallback,
  // never a supplement. Keep all evidence rows, including excluded candidates.
  const competitiveRows = [...(pinned.size > 0 ? pinned : observed).values()]
    .map(candidate => candidateRows.get(candidate.domain)!)
    .filter(row => pinned.size > 0 || row.mentionCount > 0 || row.citationCount > 0)
  const frame = buildShareOfVoiceFrame({
    tracked: pinned.size > 0,
    classSelected: options.shareOfVoiceEligible,
    projectMentions: projectRow.mentionCount,
    answeredResults,
    competitors: competitiveRows.map(row => ({ domain: row.identity.domain, mentions: row.mentionCount })),
  })
  const mentionCredits = frame.denominator
  const competitive = frame.availability === 'measured'
  const comparisonDomains = new Set(frame.domains)
  return {
    basis: frame.basis, availability: frame.availability, reason: frame.reason,
    comparison: competitiveRows.filter(row => comparisonDomains.has(row.identity.domain)).map(row => ({ domain: row.identity.domain, mentions: row.mentionCount })),
    project: finalizeRow(projectRow, answeredResults, mentionCredits, competitive),
    pinned: [...pinned.values()].map(candidate => (
      finalizeRow(candidateRows.get(candidate.domain)!, answeredResults, mentionCredits, competitive && comparisonDomains.has(candidate.domain))
    )),
    observed: [...observed.values()]
      .map(candidate => finalizeRow(candidateRows.get(candidate.domain)!, answeredResults, mentionCredits, competitive && comparisonDomains.has(candidate.domain)))
      .filter(row => row.mentionCount > 0 || row.citationCount > 0)
      .sort(compareCompetitiveRows),
    otherSources: [...others.values()]
      .map(candidate => finalizeRow(candidateRows.get(candidate.domain)!, answeredResults, mentionCredits, false))
      .sort(compareOtherRows),
    evidence: { answeredResults, sourceResults, missingAnswerTextResults, mentionCredits },
  }
}

function combineMatchers(matchers: readonly BrandAliasMatcher[]): BrandAliasMatcher {
  const keys = new Set<string>()
  let longest = 0
  for (const matcher of matchers) {
    for (const key of matcher.keys) keys.add(key)
    if (matcher.longest > longest) longest = matcher.longest
  }
  return { keys, longest }
}

/** `a.b.c` -> `a.b.c`, `b.c`, `c`: every host that `a.b.c` equals or is a subdomain of. */
function hostSuffixes(host: string): string[] {
  const suffixes = [host]
  let index = host.indexOf('.')
  while (index !== -1) {
    suffixes.push(host.slice(index + 1))
    index = host.indexOf('.', index + 1)
  }
  return suffixes
}

function normalizedHosts(domains: readonly string[]): string[] {
  return domains.flatMap(domain => {
    const normalized = hostOf(domain)
    return normalized ? [normalized] : []
  })
}

function normalizeDomain(value: string): string | null {
  return registrableDomain(value) || hostOf(value)
}

function candidateFor(input: {
  domain: string
  label: string
  labelSource?: 'domain' | 'curated'
  aliases?: readonly string[]
  surfaceClass: CompetitorLandscapeSurfaceClass
  pinned: boolean
}): Candidate {
  const host = hostOf(input.domain)
  const labelSource = input.labelSource ?? 'curated'
  const domainLabel = brandLabelFromDomain(input.domain)
  const identityAliases = [...new Set(input.aliases ?? [])]
  const matcherAliases = [
    ...(labelSource === 'curated' ? [input.label] : []),
    ...identityAliases,
    ...(brandKeyFromText(domainLabel).length >= MIN_DOMAIN_BRAND_KEY_LENGTH ? [domainLabel] : []),
    host,
  ].filter((value): value is string => (
    typeof value === 'string' && brandKeyFromText(value).length >= MIN_BRAND_ALIAS_KEY_LENGTH
  ))
  return { ...input, labelSource, aliases: identityAliases, matcher: compileBrandAliases(matcherAliases) }
}

function putCandidate(target: Map<string, Candidate>, candidate: Candidate): void {
  const existing = target.get(candidate.domain)
  target.set(candidate.domain, existing ? mergeCandidates(existing, candidate) : candidate)
}

function mergeCandidates(primary: Candidate, additional: Candidate): Candidate {
  return candidateFor({
    domain: primary.domain,
    label: primary.label,
    labelSource: primary.labelSource,
    aliases: [...new Set([
      ...primary.aliases,
      ...(additional.labelSource === 'curated' ? [additional.label] : []),
      ...additional.aliases,
    ])],
    surfaceClass: preferredSurfaceClass(primary.surfaceClass, additional.surfaceClass),
    pinned: primary.pinned || additional.pinned,
  })
}

/** The same persisted taxonomy resolution for every comparison surface. */
export function storedDirectCompetitorDomains(classifications: ReadonlyMap<string, CompetitorLandscapeSurfaceClass>): string[] {
  return [...groupClassifications(classifications)]
    .filter(([, surfaceClass]) => surfaceClass === 'direct-competitor')
    .map(([domain]) => domain)
}

function groupClassifications(
  classifications: ReadonlyMap<string, CompetitorLandscapeSurfaceClass>,
): Map<string, CompetitorLandscapeSurfaceClass> {
  const grouped = new Map<string, CompetitorLandscapeSurfaceClass>()
  for (const [classifiedHost, surfaceClass] of classifications) {
    const domain = normalizeDomain(classifiedHost)
    if (!domain) continue
    grouped.set(domain, preferredSurfaceClass(grouped.get(domain), surfaceClass))
  }
  return grouped
}

function surfaceClassForSource(
  source: string,
  domain: string,
  exact: ReadonlyMap<string, CompetitorLandscapeSurfaceClass>,
  grouped: ReadonlyMap<string, CompetitorLandscapeSurfaceClass>,
): CompetitorLandscapeSurfaceClass {
  const sourceHost = hostOf(source)
  return (sourceHost ? exact.get(sourceHost) : undefined) ?? grouped.get(domain) ?? 'unknown'
}

const SURFACE_CLASS_PRIORITY: Record<CompetitorLandscapeSurfaceClass, number> = {
  unknown: 0,
  other: 1,
  'editorial-media': 2,
  'ota-aggregator': 3,
  'direct-competitor': 4,
}

function preferredSurfaceClass(
  current: CompetitorLandscapeSurfaceClass | undefined,
  candidate: CompetitorLandscapeSurfaceClass,
): CompetitorLandscapeSurfaceClass {
  if (!current) return candidate
  return SURFACE_CLASS_PRIORITY[candidate] > SURFACE_CLASS_PRIORITY[current] ? candidate : current
}

function emptyRow(
  identity: CompetitorLandscapeIdentity,
  surfaceClass: CompetitorLandscapeHistoryRow['surfaceClass'],
  pinned: boolean,
): MutableRow {
  return {
    identity,
    surfaceClass,
    pinned,
    mentionCount: 0,
    citationCount: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    sampleUrls: new Set(),
  }
}

function recordMention(row: MutableRow, at: string): void {
  row.mentionCount++
  seen(row, at)
}

function recordCitation(row: MutableRow, at: string, source: string, sampleUrlLimit: number): void {
  row.citationCount++
  seen(row, at)
  recordSampleUrl(row, source, sampleUrlLimit)
}

function recordSampleUrl(row: MutableRow, source: string, sampleUrlLimit: number): void {
  if (sampleUrlLimit > 0 && /^https?:\/\//i.test(source) && row.sampleUrls.size < sampleUrlLimit) {
    row.sampleUrls.add(source)
  }
}

function seen(row: MutableRow, at: string): void {
  if (row.firstSeenAt === null || at < row.firstSeenAt) row.firstSeenAt = at
  if (row.lastSeenAt === null || at > row.lastSeenAt) row.lastSeenAt = at
}

function finalizeRow(
  row: MutableRow,
  answeredResults: number,
  mentionCredits: number,
  /** False for other-source rows, and for any selection that pools query classes. */
  competitive: boolean,
): CompetitorLandscapeHistoryRow {
  return {
    domain: row.identity.domain,
    label: row.identity.label,
    surfaceClass: row.surfaceClass,
    pinned: row.pinned,
    mentionCount: row.mentionCount,
    shareOfVoice: competitive
      ? (mentionCredits > 0 ? roundPercentage((row.mentionCount / mentionCredits) * 100) : null)
      : null,
    citationCount: row.citationCount,
    answeredResults,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    sampleUrls: [...row.sampleUrls],
  }
}

function roundPercentage(value: number): number {
  return Math.round(value * 10) / 10
}

function compareCompetitiveRows(a: CompetitorLandscapeHistoryRow, b: CompetitorLandscapeHistoryRow): number {
  return b.mentionCount - a.mentionCount
    || b.citationCount - a.citationCount
    || a.domain.localeCompare(b.domain)
}

function compareOtherRows(a: CompetitorLandscapeHistoryRow, b: CompetitorLandscapeHistoryRow): number {
  return b.citationCount - a.citationCount || a.domain.localeCompare(b.domain)
}

function sourcesOf(snapshot: CompetitorLandscapeHistorySnapshot): string[] {
  return [...new Set([...snapshot.citedDomains, ...(snapshot.citedUrls ?? [])])]
}
