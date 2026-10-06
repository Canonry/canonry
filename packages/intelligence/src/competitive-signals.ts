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
}

export interface CompetitiveSignalResolver {
  resolve(evidence: CompetitiveSignalEvidence): CompetitiveSignals
}

interface CompetitorIdentity {
  domain: string
  /** The competitor's names: curated aliases plus the gated domain label. */
  names: string[]
  /** `brandKeyFromText` of each name, the keys the shared matcher reports. */
  nameKeys: string[]
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
 * the alias floor, so "FoamSeal" marks `sealfoamworks.example` mentioned.
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
    identities.push({ domain, names, nameKeys: [...new Set(names.map(brandKeyFromText))] })
  }

  const nameMatcher = compileBrandAliases(
    identities.flatMap(identity => identity.names),
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

      for (const identity of identities) {
        if (citationCandidates.some(candidate => hostMatchesDomain(candidate, identity.domain))) {
          citedCompetitorDomains.push(identity.domain)
        }
        if (
          answerDomains.some(candidate => hostMatchesDomain(candidate, identity.domain))
          || identity.nameKeys.some(key => mentionedNameKeys.has(key))
        ) {
          mentionedCompetitorDomains.push(identity.domain)
        }
      }

      return { citedCompetitorDomains, mentionedCompetitorDomains }
    },
  }
}

export function resolveCompetitiveSignals(
  evidence: CompetitiveSignalEvidence,
  competitors: readonly (string | CompetitorIdentityInput)[],
): CompetitiveSignals {
  return compileCompetitiveSignalResolver(competitors).resolve(evidence)
}
