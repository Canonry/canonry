import {
  answerProseForMentions,
  brandLabelFromDomain,
  brandKeyFromText,
  competitorBrandAliases,
  extractAnswerTextAnchors,
  hostMatchesAnyDomain,
  isListingMarketplace,
  matcherMatchesText,
  normalizeCompetitorDomain,
  hostOf,
  registrableDomain,
  compileBrandAliases,
  type CompetitorIdentityInput,
  type CompetitorSuggestion,
  type CompetitorSuggestionReason,
} from '@ainyc/canonry-contracts'

export interface CompetitorSuggestionAnswer {
  id: string
  runId: string
  createdAt: string
  answerText: string | null
  citedDomains: readonly string[]
  citedUrls: readonly string[] | null
  recommendedCompetitors?: readonly string[]
}

export interface CompetitorSuggestionClassification {
  surfaceClass: CompetitorSuggestion['surfaceClass']
}

export interface BuildCompetitorSuggestionsOptions {
  project: { domain: string; label: string; domains?: readonly string[] }
  answers: readonly CompetitorSuggestionAnswer[]
  minAnswers: number
  classifications: ReadonlyMap<string, CompetitorSuggestion['surfaceClass'] | CompetitorSuggestionClassification>
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
  if (options.claimedCompetitorAdds.has(candidate.domain)) return 'claimed-by-alias'
  if (candidate.hostForms.size > 1) return 'shared-host'
  if (candidate.surfaceClass !== 'unknown' && candidate.surfaceClass !== 'direct-competitor') return 'non-competitor-surface'
  if (candidate.naming.size < options.minAnswers) return candidate.naming.size === 0 ? 'not-named' : 'below-min-answers'
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

function displayNameForDomain(text: string, domain: string): string | null {
  const label = brandLabelFromDomain(domain)
  if (!label) return null
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return null
  const regexMeta = new Set(['\\', '^', '$', '*', '+', '?', '.', '(', ')', '[', ']', '{', '}', '|'])
  const escapedWords = words.map(word => [...word].map(character => regexMeta.has(character) ? `\\${character}` : character).join(''))
  const expression = new RegExp(`\\b(${escapedWords.join('[\\s-]*')})\\b`, 'iu')
  return text.match(expression)?.[1] ?? null
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
  const namedByOtherNameAnswers = [...candidate.namedByOtherName.entries()]
    .map(([name, answers]) => ({ name, answerCount: answers.size, pairedAnswers: 0 }))
    .sort((left, right) => right.answerCount - left.answerCount || left.name.localeCompare(right.name))
    .slice(0, 20)
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
    status: candidate.tracked ? 'tracked' : reason === null ? 'suggested' : 'excluded',
    reason,
    sampleUrls: candidate.sampleUrls.slice(0, 3),
  }
}

/**
 * Build competitor candidates from stored answer text and source evidence.
 * This function is deliberately pure. The route supplies stored rows,
 * classifications, tracked identities, and the claimed alias set.
 */
export function buildCompetitorSuggestions(options: BuildCompetitorSuggestionsOptions): {
  candidates: CompetitorSuggestion[]
  unresolvedNames: Array<{ name: string; answerCount: number }>
  answeredResults: number
  sourceResults: number
} {
  const ownDomains = [options.project.domain, ...(options.project.domains ?? [])]
  const trackedByDomain = new Map(options.tracked.map(competitor => [normalizeCompetitorDomain(competitor.domain), competitor]))
  const candidates = new Map<string, MutableCandidate>()
  const unresolved = new Map<string, { name: string; answers: Set<string> }>()
  let answeredResults = 0
  let sourceResults = 0

  for (const answer of options.answers) {
    const prose = answerProseForMentions(answer.answerText)
    if (prose) answeredResults++
    const sourceValues = [...answer.citedDomains, ...(answer.citedUrls ?? [])]
    const sourceDomains = [...new Set(sourceValues.map(normalizeSource).filter(Boolean))]
    const sourceHosts = new Map<string, Set<string>>()
    for (const source of sourceValues) {
      const domain = normalizeSource(source)
      const host = hostOf(source)
      if (!domain || !host) continue
      const hosts = sourceHosts.get(domain) ?? new Set<string>()
      hosts.add(host)
      sourceHosts.set(domain, hosts)
    }
    if (sourceDomains.length > 0) sourceResults++
    const anchors = extractAnswerTextAnchors(answer.answerText)
    const names = new Set<string>(answer.recommendedCompetitors ?? [])
    for (const anchor of anchors) names.add(anchor.text)
    const anchoredDomains = new Map<string, Set<string>>()
    for (const anchor of anchors) {
      const domain = normalizeSource(anchor.source)
      const namesForDomain = anchoredDomains.get(domain) ?? new Set<string>()
      namesForDomain.add(anchor.text)
      anchoredDomains.set(domain, namesForDomain)
    }
    const namedDomainKeys = new Set<string>()
    const answerCandidates = new Set<string>()
    for (const domain of sourceDomains) {
      if (hostMatchesAnyDomain(domain, ownDomains) || isListingMarketplace(domain)) continue
      const tracked = trackedByDomain.get(domain)
      const label = brandLabelFromDomain(domain) || domain
      const matcherAliases = tracked ? competitorBrandAliases(tracked) : [label, domain]
      const namedByLabel = Boolean(prose && matcherMatchesText(compileBrandAliases(matcherAliases), prose))
      const domainAnchors = anchoredDomains.get(domain) ?? new Set<string>()
      const pairedByAnchor = domainAnchors.size > 0
      const candidate = candidates.get(domain) ?? {
        domain,
        label,
        surfaceClass: (unwrapClass(options.classifications.get(domain)) ?? 'unknown') as CompetitorSuggestion['surfaceClass'],
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
      for (const host of sourceHosts.get(domain) ?? [domain]) candidate.hostForms.add(host)
      if (answer.createdAt > (candidate.lastSeenAt ?? '')) candidate.lastSeenAt = answer.createdAt
      if (candidate.firstSeenAt === null || answer.createdAt < candidate.firstSeenAt) candidate.firstSeenAt = answer.createdAt
      for (const url of answer.citedUrls ?? []) {
        if (normalizeSource(url) === domain && /^https?:\/\//iu.test(url) && !candidate.sampleUrls.includes(url)) candidate.sampleUrls.push(url)
      }
      if (namedByLabel) {
        candidate.naming.add(answer.id)
        candidate.both.add(answer.id)
        const displayName = displayNameForDomain(prose!, domain) ?? label
        addName(candidate, displayName, answer.id, true)
        namedDomainKeys.add(domain)
      }
      if (pairedByAnchor) {
        candidate.paired.add(answer.id)
        for (const name of domainAnchors) {
          if (candidate.names.has(brandKeyFromText(name))) continue
          const existing = candidate.namedByOtherName.get(name) ?? new Set<string>()
          existing.add(answer.id)
          candidate.namedByOtherName.set(name, existing)
        }
        answerCandidates.add(domain)
      }
      if (namedByLabel) answerCandidates.add(domain)
    }
    for (const name of names) {
      const key = brandKeyFromText(name)
      if (!key || [...answerCandidates].some(domain => {
        const candidate = candidates.get(domain)
        return candidate
          ? [...candidate.names.values()].some(entry => [...entry.answers].includes(answer.id))
            || [...candidate.namedByOtherName.values()].some(answerIds => answerIds.has(answer.id))
          : false
      })) continue
      const unresolvedAnswers = unresolved.get(key) ?? { name: name.trim(), answers: new Set<string>() }
      unresolvedAnswers.answers.add(answer.id)
      unresolved.set(key, unresolvedAnswers)
    }
    for (const domain of answerCandidates) {
      const candidate = candidates.get(domain)!
      for (const name of names) {
        if (!candidate.names.has(brandKeyFromText(name))) {
          const existing = candidate.namedByOtherName.get(name) ?? new Set<string>()
          existing.add(answer.id)
          candidate.namedByOtherName.set(name, existing)
        }
      }
    }
    for (const domain of namedDomainKeys) {
      const candidate = candidates.get(domain)!
      candidate.paired.add(answer.id)
    }
  }

  const result = [...candidates.values()].map(candidate => candidateDto(candidate, options))
  const unresolvedNames = [...unresolved.values()]
    .map(entry => ({ name: entry.name, answerCount: entry.answers.size }))
    .sort((left, right) => right.answerCount - left.answerCount || left.name.localeCompare(right.name))
  return { candidates: result, unresolvedNames, answeredResults, sourceResults }
}

function unwrapClass(value: CompetitorSuggestion['surfaceClass'] | CompetitorSuggestionClassification | undefined): CompetitorSuggestion['surfaceClass'] | undefined {
  return typeof value === 'string' ? value : value?.surfaceClass
}
