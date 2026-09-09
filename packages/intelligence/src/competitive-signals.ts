import {
  MIN_DOMAIN_BRAND_KEY_LENGTH,
  brandKeyFromText,
  brandLabelFromDomain,
  compileBrandAliases,
  extractDomainsFromText,
  hostMatchesDomain,
  hostOf,
  matchedAliasKeys,
} from '@ainyc/canonry-contracts'

export interface CompetitiveSignalSource {
  uri: string
}

export interface CompetitiveSignalEvidence {
  citedDomains?: readonly string[]
  groundingSources?: readonly CompetitiveSignalSource[]
  answerText?: string | null
  /** Request-scoped prose-domain result, when another reader already has it. */
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
  domainBrandKey: string | null
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
 */
export function compileCompetitiveSignalResolver(
  competitorDomains: readonly string[],
): CompetitiveSignalResolver {
  const identities: CompetitorIdentity[] = []
  const seen = new Set<string>()

  for (const candidate of competitorDomains) {
    const domain = hostOf(candidate)
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    const domainBrandKey = brandKeyFromText(brandLabelFromDomain(domain))
    identities.push({
      domain,
      domainBrandKey: domainBrandKey.length >= MIN_DOMAIN_BRAND_KEY_LENGTH
        ? domainBrandKey
        : null,
    })
  }

  const domainBrandMatcher = compileBrandAliases(
    identities
      .filter(identity => identity.domainBrandKey !== null)
      .map(identity => brandLabelFromDomain(identity.domain)),
  )

  return {
    resolve(evidence): CompetitiveSignals {
      const citationCandidates = [
        ...(evidence.citedDomains ?? []),
        ...(evidence.groundingSources ?? []).map(source => source.uri),
      ]
      const answerDomains = evidence.answerDomains ?? extractDomainsFromText(evidence.answerText)
      const mentionedBrandKeys = matchedAliasKeys(domainBrandMatcher, evidence.answerText)
      const citedCompetitorDomains: string[] = []
      const mentionedCompetitorDomains: string[] = []

      for (const identity of identities) {
        if (citationCandidates.some(candidate => hostMatchesDomain(candidate, identity.domain))) {
          citedCompetitorDomains.push(identity.domain)
        }
        if (
          answerDomains.some(candidate => hostMatchesDomain(candidate, identity.domain))
          || (identity.domainBrandKey !== null && mentionedBrandKeys.has(identity.domainBrandKey))
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
  competitorDomains: readonly string[],
): CompetitiveSignals {
  return compileCompetitiveSignalResolver(competitorDomains).resolve(evidence)
}
