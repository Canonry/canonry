import {
  answerProseForMentions,
  brandKeyFromText,
  compileBrandAliases,
  competitorNameAliases,
  extractDomainsFromText,
  hostMatchesDomain,
  hostOf,
  matchedAliasKeys,
  type CompetitorIdentityInput,
} from '@ainyc/canonry-contracts'

export interface CompetitiveSignalSource {
  uri: string
}

export interface CompetitiveSignalEvidence {
  citedDomains?: readonly string[]
  groundingSources?: readonly CompetitiveSignalSource[]
  answerText?: string | null
  /**
   * Request-scoped prose-domain result, when another reader already has it:
   * `extractDomainsFromText(answerProseForMentions(answerText))`.
   */
  answerDomains?: readonly string[]
}

/**
 * Two independent observations for one answer. A competitor can be cited in
 * the source list, mentioned in the answer prose, both, or neither.
 */
export interface CompetitiveSignals {
  citedCompetitorDomains: string[]
  mentionedCompetitorDomains: string[]
  /**
   * The identities that made each mention: the competitor names (curated
   * aliases, gated domain labels) and written hosts found in the prose, in
   * competitor order. Readers highlight these instead of re-deriving names.
   */
  mentionedCompetitorTerms: string[]
}

export interface CompetitiveSignalResolver {
  resolve(evidence: CompetitiveSignalEvidence): CompetitiveSignals
}

interface CompetitorIdentity {
  domain: string
  /**
   * The competitor's names (curated aliases plus the gated domain label), each
   * with its `brandKeyFromText` key, the key the shared matcher reports.
   */
  names: Array<{ name: string; key: string }>
}

/**
 * Compile tracked competitor identities once, then resolve independent
 * citation and mention signals for many snapshots.
 *
 * Citation evidence comes only from source material (`citedDomains` and
 * grounding-source URIs). Mention evidence comes only from `answerText`.
 * Exact written domains are always strong identities. A bare label derived
 * from a domain uses the same specificity floor as project answer mentions,
 * so `ai.com` is recognized when written but the generic word "AI" is not.
 * Operator-curated aliases (`{ domain, aliases }` entries) are names too, at
 * the alias floor, so "TuneSpoke" marks `spoketuneworks.example` mentioned.
 * A bare string entry is a domain with no curated alias.
 */
export function compileCompetitiveSignalResolver(
  competitors: readonly (string | CompetitorIdentityInput)[],
): CompetitiveSignalResolver {
  const identities: CompetitorIdentity[] = []
  const seen = new Set<string>()

  for (const candidate of competitors) {
    const input = typeof candidate === 'string' ? { domain: candidate } : candidate
    const domain = hostOf(input.domain)
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    const names = competitorNameAliases({ domain, aliases: input.aliases })
    identities.push({ domain, names: names.map(name => ({ name, key: brandKeyFromText(name) })) })
  }

  const nameMatcher = compileBrandAliases(
    identities.flatMap(identity => identity.names.map(entry => entry.name)),
  )

  return {
    resolve(evidence): CompetitiveSignals {
      const citationCandidates = [
        ...(evidence.citedDomains ?? []),
        ...(evidence.groundingSources ?? []).map(source => source.uri),
      ]
      // Mentions read the answer's prose: a citation chip in the text is a citation.
      const prose = answerProseForMentions(evidence.answerText)
      const answerDomains = evidence.answerDomains ?? extractDomainsFromText(prose)
      const mentionedNameKeys = matchedAliasKeys(nameMatcher, prose)
      const citedCompetitorDomains: string[] = []
      const mentionedCompetitorDomains: string[] = []
      const mentionedCompetitorTerms = new Set<string>()

      for (const identity of identities) {
        if (citationCandidates.some(candidate => hostMatchesDomain(candidate, identity.domain))) {
          citedCompetitorDomains.push(identity.domain)
        }
        const writtenHosts = answerDomains.filter(candidate => hostMatchesDomain(candidate, identity.domain))
        const names = identity.names.filter(entry => mentionedNameKeys.has(entry.key)).map(entry => entry.name)
        if (writtenHosts.length > 0 || names.length > 0) {
          mentionedCompetitorDomains.push(identity.domain)
          for (const term of [...names, ...writtenHosts]) mentionedCompetitorTerms.add(term)
        }
      }

      return { citedCompetitorDomains, mentionedCompetitorDomains, mentionedCompetitorTerms: [...mentionedCompetitorTerms] }
    },
  }
}

export function resolveCompetitiveSignals(
  evidence: CompetitiveSignalEvidence,
  competitors: readonly (string | CompetitorIdentityInput)[],
): CompetitiveSignals {
  return compileCompetitiveSignalResolver(competitors).resolve(evidence)
}
