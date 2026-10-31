import {
  answerProseForMentions,
  CompetitorSuggestionReasons,
  CompetitorSuggestionStatuses,
  aliasOccurrencesAsWritten,
  brandLabelFromDomain,
  brandKeyFromText,
  competitorBrandAliases,
  competitorDomainProjectClaim,
  extractAnswerTextAnchors,
  isListingMarketplace,
  normalizeCompetitorDomain,
  normalizeProjectDomain,
  hostOf,
  registrableDomain,
  compileBrandAliases,
  type CompetitorIdentityInput,
  type CompetitorSuggestion,
  type CompetitorSuggestionReason,
} from '@canonry/canonry-contracts'
import { groupStoredCompetitorClassifications, type CompetitorLandscapeSurfaceClass } from './competitor-landscape-history.js'

export interface CompetitorSuggestionAnswer {
  id: string
  runId: string
  createdAt: string
  answerText: string | null
  citedDomains: readonly string[]
  citedUrls: readonly string[] | null
  recommendedCompetitors?: readonly string[]
  /** Current pins plus frozen identities for this answer's selected landscape scope. */
  competitors?: readonly CompetitorIdentityInput[]
}

export interface CompetitorSuggestionClassification {
  surfaceClass: CompetitorLandscapeSurfaceClass
}

export interface BuildCompetitorSuggestionsOptions {
  project: { domain: string; label: string; domains?: readonly string[] }
  answers: readonly CompetitorSuggestionAnswer[]
  minAnswers: number
  classifications: ReadonlyMap<string, CompetitorLandscapeSurfaceClass | CompetitorSuggestionClassification>
  tracked: readonly CompetitorIdentityInput[]
  claimedCompetitorAdds: ReadonlySet<string>
  marketKeys?: ReadonlyMap<string, readonly string[]>
}

interface MutableCandidate {
  domain: string
  label: string
  surfaceClass: CompetitorSuggestion['surfaceClass']
  tracked: boolean
  marketKeys?: string[]
  naming: Set<string>
  citing: Set<string>
  both: Set<string>
  paired: Set<string>
  names: Map<string, { name: string; answers: Set<string>; paired: Set<string> }>
  namedByOtherName: Map<string, Set<string>>
  sweeps: Set<string>
  firstSeenAt: string | null
  lastSeenAt: string | null
  sampleUrls: string[]
  hostForms: Set<string>
  reason: CompetitorSuggestionReason | null
}

function candidateReason(candidate: MutableCandidate, options: BuildCompetitorSuggestionsOptions): CompetitorSuggestionReason | null {
  if (candidate.tracked) return null
  if (candidate.reason) return candidate.reason
  if (options.claimedCompetitorAdds.has(candidate.domain)) return CompetitorSuggestionReasons['claimed-by-alias']
  if (candidate.hostForms.size > 1) return CompetitorSuggestionReasons['shared-host']
  if (candidate.surfaceClass !== 'unknown' && candidate.surfaceClass !== 'direct-competitor') return CompetitorSuggestionReasons['non-competitor-surface']
  if (candidate.naming.size < options.minAnswers) return candidate.naming.size === 0 ? CompetitorSuggestionReasons['not-named'] : CompetitorSuggestionReasons['below-min-answers']
  if (candidate.paired.size === 0 && candidate.surfaceClass !== 'direct-competitor') return CompetitorSuggestionReasons['unpaired-name']
  return null
}

function normalizeSource(value: string): string {
  return registrableDomain(value) || normalizeCompetitorDomain(value)
}

function addName(candidate: MutableCandidate, name: string, answerId: string, paired: boolean): void {
  const trimmed = name.trim()
  if (!trimmed) return
  const existing = candidate.names.get(brandKeyFromText(trimmed))
  if (existing) {
    existing.answers.add(answerId)
    if (paired) existing.paired.add(answerId)
    return
  }
  candidate.names.set(brandKeyFromText(trimmed), { name: trimmed, answers: new Set([answerId]), paired: paired ? new Set([answerId]) : new Set() })
}

function candidateDto(candidate: MutableCandidate, options: BuildCompetitorSuggestionsOptions): CompetitorSuggestion {
  const names = [...candidate.names.entries()]
    .map(([, entry]) => ({
      name: entry.name,
      answerCount: entry.answers.size,
      pairedAnswers: entry.paired.size,
    }))
    .sort((left, right) => right.answerCount - left.answerCount || left.name.localeCompare(right.name))
    .slice(0, 5)
  const namedByOtherNameAnswers = new Set([...candidate.namedByOtherName.values()].flatMap(answers => [...answers])).size
  const reason = candidateReason(candidate, options)
  return {
    domain: candidate.domain,
    label: candidate.label,
    names,
    namingAnswers: candidate.naming.size,
    citingAnswers: candidate.citing.size,
    bothAnswers: candidate.both.size,
    pairedAnswers: candidate.paired.size,
    namedByOtherNameAnswers,
    sweeps: candidate.sweeps.size,
    firstSeenAt: candidate.firstSeenAt,
    lastSeenAt: candidate.lastSeenAt,
    surfaceClass: candidate.surfaceClass,
    tracked: candidate.tracked,
    ...(candidate.marketKeys && candidate.marketKeys.length > 0 ? { marketKeys: candidate.marketKeys } : {}),
    status: candidate.tracked ? CompetitorSuggestionStatuses.tracked : reason === null ? CompetitorSuggestionStatuses.suggested : CompetitorSuggestionStatuses.excluded,
    reason,
    sampleUrls: candidate.sampleUrls.slice(0, 3),
  }
}

/**
 * Build competitor candidates from stored answer text and source evidence.
 * Output depends only on the supplied evidence; scheduling yields keep the host responsive.
 * The route supplies stored rows,
 * classifications, tracked identities, and the claimed alias set.
 */
export async function buildCompetitorSuggestions(options: BuildCompetitorSuggestionsOptions): Promise<{
  candidates: CompetitorSuggestion[]
  unresolvedNames: Array<{ name: string; answerCount: number }>
  answeredResults: number
  sourceResults: number
}> {
  const ownDomains = [options.project.domain, ...(options.project.domains ?? [])]
  const trackedByDomain = new Map<string, CompetitorIdentityInput>()
  for (const competitor of options.tracked) {
    trackedByDomain.set(normalizeCompetitorDomain(competitor.domain), competitor)
    const registrable = registrableDomain(competitor.domain)
    if (registrable) trackedByDomain.set(registrable, competitor)
  }
  const classifications = groupStoredCompetitorClassifications(new Map([...options.classifications].map(([host, value]) => [host, unwrapClass(value)!])))
  const candidates = new Map<string, MutableCandidate>()
  const unresolved = new Map<string, { name: string; answers: Set<string> }>()
  const resolvedNameKeysByAnswer = new Map<string, Set<string>>()
  let answeredResults = 0
  let sourceResults = 0
  let nextYield = performance.now() + 8
  const yieldToEventLoop = async (): Promise<void> => {
    if (performance.now() < nextYield) return
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    nextYield = performance.now() + 8
  }

  for (const answer of options.answers) {
    await yieldToEventLoop()
    const resolvedNameKeys = new Set<string>()
    resolvedNameKeysByAnswer.set(answer.id, resolvedNameKeys)
    const prose = answerProseForMentions(answer.answerText)
    if (prose) answeredResults++
    const sourceValues = [...answer.citedDomains, ...(answer.citedUrls ?? [])]
    const sourceDomains = new Set<string>()
    const sourceUrls = new Map<string, string[]>()
    const sourceHosts = new Map<string, Set<string>>()
    for (const source of sourceValues) {
      await yieldToEventLoop()
      const domain = normalizeSource(source)
      if (domain) sourceDomains.add(domain)
      if (/^https?:\/\//iu.test(source)) {
        const urls = sourceUrls.get(domain) ?? []
        if (urls.length < 3 && !urls.includes(source)) urls.push(source)
        sourceUrls.set(domain, urls)
      }
      const host = hostOf(source)
      if (!domain || !host) continue
      const hosts = sourceHosts.get(domain) ?? new Set<string>()
      hosts.add(host)
      sourceHosts.set(domain, hosts)
    }
    if (sourceDomains.size > 0) sourceResults++
    const anchors = extractAnswerTextAnchors(answer.answerText)
    const anchoredDomains = new Map<string, Set<string>>()
    for (const anchor of anchors) {
      await yieldToEventLoop()
      const domain = normalizeSource(anchor.source)
      const namesForDomain = anchoredDomains.get(domain) ?? new Set<string>()
      namesForDomain.add(anchor.text)
      anchoredDomains.set(domain, namesForDomain)
    }
    for (const domain of sourceDomains) {
      await yieldToEventLoop()
      if (competitorDomainProjectClaim(domain, ownDomains) || isListingMarketplace(domain)) continue
      const tracked = trackedByDomain.get(domain)
      const label = brandLabelFromDomain(domain) || domain
      const domainAnchors = anchoredDomains.get(domain) ?? new Set<string>()
      const pairedByAnchor = domainAnchors.size > 0
      const candidate = candidates.get(domain) ?? {
        domain,
        label,
        surfaceClass: (classifications.get(domain) ?? 'unknown') as CompetitorSuggestion['surfaceClass'],
        tracked: Boolean(tracked),
        ...(options.marketKeys?.get(domain) ? { marketKeys: [...options.marketKeys.get(domain)!] } : {}),
        naming: new Set<string>(),
        citing: new Set<string>(),
        both: new Set<string>(),
        paired: new Set<string>(),
        names: new Map<string, { name: string; answers: Set<string>; paired: Set<string> }>(),
        namedByOtherName: new Map<string, Set<string>>(),
        sweeps: new Set<string>(),
        firstSeenAt: null,
        lastSeenAt: null,
        sampleUrls: [] as string[],
        hostForms: new Set<string>(),
        reason: null,
      }
      candidates.set(domain, candidate)
      candidate.citing.add(answer.id)
      candidate.sweeps.add(answer.runId)
      for (const host of sourceHosts.get(domain) ?? [domain]) candidate.hostForms.add(normalizeProjectDomain(host))
      if (answer.createdAt > (candidate.lastSeenAt ?? '')) candidate.lastSeenAt = answer.createdAt
      if (candidate.firstSeenAt === null || answer.createdAt < candidate.firstSeenAt) candidate.firstSeenAt = answer.createdAt
      for (const url of sourceUrls.get(domain) ?? []) {
        if (candidate.sampleUrls.length < 3 && !candidate.sampleUrls.includes(url)) candidate.sampleUrls.push(url)
      }
      if (pairedByAnchor) {
        candidate.paired.add(answer.id)
        for (const name of domainAnchors) {
          addName(candidate, name, answer.id, true)
          if (brandKeyFromText(name) !== brandKeyFromText(candidate.label)) {
            const existing = candidate.namedByOtherName.get(name) ?? new Set<string>()
            existing.add(answer.id)
            candidate.namedByOtherName.set(name, existing)
          }
          resolvedNameKeys.add(brandKeyFromText(name))
        }
      }
    }
  }

  type MatcherIndex = {
    matcher: ReturnType<typeof compileBrandAliases>
    candidatesByAlias: Map<string, string[]>
  }
  const matcherIndexes = new Map<string, MatcherIndex>()
  const matcherIndexFor = async (scoped: Map<string, CompetitorIdentityInput> | undefined): Promise<MatcherIndex> => {
    // Answers in one frozen scope share the same identity selection. One
    // matcher for that selection avoids repeating the word walk for every
    // candidate while retaining all candidate owners for overlapping aliases.
    const scopeEntries: Array<[string, string[]]> = scoped === undefined
      ? []
      : [...scoped.entries()].map(([domain, identity]) => [domain, competitorBrandAliases(identity)])
    const scopeKey = scoped === undefined
      ? 'default'
      : JSON.stringify(scopeEntries.sort(([left], [right]) => left.localeCompare(right)))
    const cached = matcherIndexes.get(scopeKey)
    if (cached) return cached

    const candidatesByAlias = new Map<string, string[]>()
    for (const candidate of candidates.values()) {
      await yieldToEventLoop()
      const identity = scoped === undefined ? trackedByDomain.get(candidate.domain) : scoped.get(candidate.domain)
      if (scoped !== undefined && candidate.tracked && !identity) continue
      for (const alias of competitorBrandAliases(identity ?? { domain: candidate.domain })) {
        const key = brandKeyFromText(alias)
        if (!key) continue
        const owners = candidatesByAlias.get(key) ?? []
        if (!owners.includes(candidate.domain)) owners.push(candidate.domain)
        candidatesByAlias.set(key, owners)
      }
    }
    const index = { matcher: compileBrandAliases([...candidatesByAlias.keys()]), candidatesByAlias }
    matcherIndexes.set(scopeKey, index)
    return index
  }

  // Count canonical identity matches across every selected answer after the
  // candidate universe is known. This preserves the bare-add invariant when a
  // source is first cited in a later answer, including the domain-label floor.
  for (const answer of options.answers) {
    await yieldToEventLoop()
    const prose = answerProseForMentions(answer.answerText)
    const resolvedNameKeys = resolvedNameKeysByAnswer.get(answer.id)!
    const scoped = answer.competitors === undefined ? undefined
      : new Map(answer.competitors.map(competitor => [normalizeCompetitorDomain(competitor.domain), competitor]))
    const index = await matcherIndexFor(scoped)
    const occurrences = aliasOccurrencesAsWritten(index.matcher, prose)
    for (const [aliasKey, writtenOccurrences] of occurrences) {
      for (const domain of index.candidatesByAlias.get(aliasKey) ?? []) {
        await yieldToEventLoop()
        const candidate = candidates.get(domain)
        if (!candidate) continue
        const cited = candidate.citing.has(answer.id)
        candidate.naming.add(answer.id)
        candidate.sweeps.add(answer.runId)
        if (candidate.firstSeenAt === null || answer.createdAt < candidate.firstSeenAt) candidate.firstSeenAt = answer.createdAt
        if (candidate.lastSeenAt === null || answer.createdAt > candidate.lastSeenAt) candidate.lastSeenAt = answer.createdAt
        if (cited) {
          candidate.both.add(answer.id)
          candidate.paired.add(answer.id)
        }
        for (const writtenWords of writtenOccurrences) {
          const name = writtenWords.join(' ')
          addName(candidate, name, answer.id, cited)
          resolvedNameKeys.add(brandKeyFromText(name))
        }
      }
    }
    const names = new Set<string>(answer.recommendedCompetitors ?? [])
    for (const anchor of extractAnswerTextAnchors(answer.answerText)) names.add(anchor.text)
    for (const name of names) {
      const key = brandKeyFromText(name)
      if (!key || resolvedNameKeys.has(key)) continue
      const unresolvedAnswers = unresolved.get(key) ?? { name: name.trim(), answers: new Set<string>() }
      unresolvedAnswers.answers.add(answer.id)
      unresolved.set(key, unresolvedAnswers)
    }
  }

  const result = [...candidates.values()].map(candidate => candidateDto(candidate, options))
  const unresolvedNames = [...unresolved.values()]
    .map(entry => ({ name: entry.name, answerCount: entry.answers.size }))
    .sort((left, right) => right.answerCount - left.answerCount || left.name.localeCompare(right.name))
  return { candidates: result, unresolvedNames, answeredResults, sourceResults }
}

function unwrapClass(value: CompetitorLandscapeSurfaceClass | CompetitorSuggestionClassification | undefined): CompetitorLandscapeSurfaceClass | undefined {
  return typeof value === 'string' ? value : value?.surfaceClass
}
