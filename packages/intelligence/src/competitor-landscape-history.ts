import {
  brandKeyFromText,
  brandLabelFromDomain,
  compileBrandAliases,
  hostMatchesAnyDomain,
  hostMatchesDomain,
  hostOf,
  matcherMatchesText,
  registrableDomain,
  type BrandAliasMatcher,
} from '@ainyc/canonry-contracts'
import { MIN_BRAND_ALIAS_KEY_LENGTH } from './mention-share.js'

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
}

export interface CompetitorLandscapeIdentity {
  domain: string
  label: string
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
  /**
   * Frozen Advanced Measurement competitors from the selected historical runs.
   * They are eligible direct competitors even when discovery never classified
   * their domain or the answer only mentioned (rather than cited) them.
   */
  historicalDirect?: readonly CompetitorLandscapeIdentity[]
  /** Discovery's persisted domain type. This read never invokes discovery/LLM work. */
  classifications: ReadonlyMap<string, CompetitorLandscapeSurfaceClass>
  snapshots: readonly CompetitorLandscapeHistorySnapshot[]
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
  /** Percentage points (0..100), null when this row is outside the competitive denominator. */
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

export interface CompetitorLandscapeHistoryResult {
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
  const projectDomains = normalizedDomains(options.project.domains)
  const projectDomain = normalizeDomain(options.project.domain) ?? options.project.domain
  const pinned = new Map<string, Candidate>()
  for (const identity of options.pinned) {
    const domain = normalizeDomain(identity.domain)
    if (!domain || hostMatchesAnyDomain(domain, projectDomains)) continue
    pinned.set(domain, candidateFor({
      domain,
      label: identity.label,
      aliases: identity.aliases,
      pinned: true,
      surfaceClass: 'direct-competitor',
    }))
  }

  // Known direct identities are candidates before source evidence is inspected:
  // a stored discovery classification or frozen market competitor can be named
  // in answer prose without being cited. We suppress zero-activity observed rows
  // when finalizing, while pins deliberately remain visible at zero.
  const observed = new Map<string, Candidate>()
  const others = new Map<string, Candidate>()
  for (const [classifiedDomain, surfaceClass] of options.classifications) {
    const domain = normalizeDomain(classifiedDomain)
    if (!domain || surfaceClass !== 'direct-competitor' || hostMatchesAnyDomain(domain, projectDomains) || pinned.has(domain)) continue
    observed.set(domain, candidateFor({
      domain,
      label: brandLabelFromDomain(domain) || domain,
      pinned: false,
      surfaceClass,
    }))
  }
  for (const identity of options.historicalDirect ?? []) {
    const domain = normalizeDomain(identity.domain)
    if (!domain || hostMatchesAnyDomain(domain, projectDomains) || pinned.has(domain)) continue
    observed.set(domain, candidateFor({
      domain,
      label: identity.label,
      aliases: identity.aliases,
      pinned: false,
      surfaceClass: 'direct-competitor',
    }))
  }
  for (const snapshot of options.snapshots) {
    for (const source of sourcesOf(snapshot)) {
      const domain = normalizeDomain(source)
      if (!domain || hostMatchesAnyDomain(domain, projectDomains) || pinned.has(domain)) continue
      // Frozen/direct candidates already own this domain. A missing discovery
      // classification must not demote their citation into otherSources.
      if (observed.has(domain)) continue
      const surfaceClass = options.classifications.get(domain) ?? 'unknown'
      const candidate = candidateFor({
        domain,
        label: brandLabelFromDomain(domain) || domain,
        pinned: false,
        surfaceClass,
      })
      if (surfaceClass === 'direct-competitor') {
        if (!observed.has(domain)) observed.set(domain, candidate)
      } else {
        others.set(domain, candidate)
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

  for (const snapshot of options.snapshots) {
    const text = snapshot.answerText?.trim() ?? ''
    const sources = sourcesOf(snapshot)
    if (sources.length > 0) sourceResults++
    if (text === '' && sources.length > 0) missingAnswerTextResults++

    if (text !== '') {
      answeredResults++
      if (snapshot.projectMentioned) recordMention(projectRow, snapshot.createdAt)
      for (const candidate of [...pinned.values(), ...observed.values()]) {
        if (matcherMatchesText(candidate.matcher, text)) {
          recordMention(candidateRows.get(candidate.domain)!, snapshot.createdAt)
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
      if (hostMatchesAnyDomain(normalized, projectDomains)) {
        if (!seenCitationDomains.has(projectDomain)) {
          seenCitationDomains.add(projectDomain)
          recordCitation(projectRow, snapshot.createdAt, source, sampleUrlLimit)
        } else {
          recordSampleUrl(projectRow, source, sampleUrlLimit)
        }
        continue
      }
      for (const [domain, row] of candidateRows) {
        if (!hostMatchesDomain(normalized, domain)) continue
        if (seenCitationDomains.has(domain)) {
          recordSampleUrl(row, source, sampleUrlLimit)
          continue
        }
        seenCitationDomains.add(domain)
        recordCitation(row, snapshot.createdAt, source, sampleUrlLimit)
      }
    }
  }

  const competitiveRows = [...pinned.values(), ...observed.values()]
    .map(candidate => candidateRows.get(candidate.domain)!)
  const mentionCredits = projectRow.mentionCount
    + competitiveRows.reduce((sum, row) => sum + row.mentionCount, 0)

  return {
    project: finalizeRow(projectRow, answeredResults, mentionCredits, true),
    pinned: [...pinned.values()].map(candidate => (
      finalizeRow(candidateRows.get(candidate.domain)!, answeredResults, mentionCredits, true)
    )),
    observed: [...observed.values()]
      .map(candidate => finalizeRow(candidateRows.get(candidate.domain)!, answeredResults, mentionCredits, true))
      .filter(row => row.mentionCount > 0 || row.citationCount > 0)
      .sort(compareCompetitiveRows),
    otherSources: [...others.values()]
      .map(candidate => finalizeRow(candidateRows.get(candidate.domain)!, answeredResults, mentionCredits, false))
      .sort(compareOtherRows),
    evidence: { answeredResults, sourceResults, missingAnswerTextResults, mentionCredits },
  }
}

function normalizedDomains(domains: readonly string[]): string[] {
  return domains.flatMap(domain => {
    const normalized = normalizeDomain(domain)
    return normalized ? [normalized] : []
  })
}

function normalizeDomain(value: string): string | null {
  return registrableDomain(value) || hostOf(value)
}

function candidateFor(input: {
  domain: string
  label: string
  aliases?: readonly string[]
  surfaceClass: CompetitorLandscapeSurfaceClass
  pinned: boolean
}): Candidate {
  const host = hostOf(input.domain)
  const aliases = [
    input.label,
    ...(input.aliases ?? []),
    brandLabelFromDomain(input.domain),
    host,
  ].filter((value): value is string => (
    typeof value === 'string' && brandKeyFromText(value).length >= MIN_BRAND_ALIAS_KEY_LENGTH
  ))
  return { ...input, matcher: compileBrandAliases(aliases) }
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
