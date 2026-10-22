import {
  ANSWER_EVIDENCE_VERSION,
  answerServiceRouteName,
  citationBasisFor,
  clampAnswerSourceExcerpts,
  CompletionStatuses,
  deriveRetrievalStatus,
  DisclosedModelKinds,
  groundingSourcesFromEvidence,
  normalizeServedModel,
  RetrievalContracts,
  type AnswerEvidence,
  type AnswerServiceDescriptor,
  type AnswerServiceProfile,
  type LocationTreatment,
  type ProviderUsage,
  type RawQueryResult,
} from '@canonry/canonry-contracts'
import type { ParsedAnswer } from './types.js'

/** Largest raw payload stored with an answer. Larger payloads keep a marker instead. */
export const MAX_STORED_RAW_BYTES = 1024 * 1024

export interface StoredRaw {
  raw: Record<string, unknown>
  truncated: boolean
}

/** Keep the upstream payload verbatim when it fits; otherwise store a marker and say so. */
export function boundRawResponse(raw: Record<string, unknown>, bytes: number): StoredRaw {
  if (bytes <= MAX_STORED_RAW_BYTES) return { raw, truncated: false }
  return {
    raw: { truncated: true, originalBytes: bytes, note: `Raw response exceeded ${MAX_STORED_RAW_BYTES} bytes and was not stored.` },
    truncated: true,
  }
}

/**
 * The stream did not reach the vendor's final event, so whatever the parser
 * concluded, the answer is not complete.
 */
export function enforceStreamCompletion(parsed: ParsedAnswer, ended: 'terminal' | 'eof' | 'aborted'): ParsedAnswer {
  if (ended === 'terminal' || parsed.completion.status !== CompletionStatuses.complete) return parsed
  return {
    ...parsed,
    completion: {
      ...parsed.completion,
      status: CompletionStatuses.partial,
      error: parsed.completion.error ?? (ended === 'aborted' ? 'The stream stopped before its final event.' : 'The stream ended before its final event.'),
    },
  }
}

/** A complete status with no answer text is not an answer. */
export function enforceAnswerPresent(parsed: ParsedAnswer): ParsedAnswer {
  if (parsed.completion.status !== CompletionStatuses.complete || parsed.answerText?.trim()) return parsed
  return { ...parsed, completion: { ...parsed.completion, status: CompletionStatuses.failed, error: parsed.completion.error ?? 'The response carried no answer text.' } }
}

export function assembleEvidence(input: {
  descriptor: AnswerServiceDescriptor
  profile: AnswerServiceProfile
  parsed: ParsedAnswer
  location: LocationTreatment
  rawTruncated: boolean
}): AnswerEvidence {
  const { descriptor, profile, parsed } = input
  const citationBasis = citationBasisFor(profile.capabilities.evidence.relationships)
  // Excerpt bounds are enforced here, once, so no parser has to remember them.
  const sources = clampAnswerSourceExcerpts(parsed.sources)
  return {
    version: ANSWER_EVIDENCE_VERSION,
    identity: {
      connection: descriptor.id,
      route: answerServiceRouteName(descriptor.id, profile.id),
      service: descriptor.id,
      product: profile.product,
      profile: profile.id,
      settings: { ...profile.settings },
      requestedServiceModel: profile.requestedServiceModel,
      disclosedModel: parsed.disclosedModel,
      disclosedModelKind: parsed.disclosedModel === null ? null : profile.capabilities.disclosedModelKind,
      requestPolicy: profile.requestPolicyVersion,
      parserVersion: descriptor.parserVersion,
    },
    completion: parsed.completion,
    usage: parsed.usage,
    sources,
    searchQueries: parsed.searchQueries,
    retrievalStatus: deriveRetrievalStatus({
      sources,
      searchEventCount: parsed.searchEventCount,
      reportedSearchCount: parsed.usage.searches.basis === 'reported' ? parsed.usage.searches.count : null,
      observability: profile.capabilities.evidence.retrievalObservability,
      completion: parsed.completion,
    }),
    citationBasis,
    citationMeasurable: citationBasis !== 'none',
    directSourceUrls: profile.capabilities.evidence.directUrls,
    location: input.location,
    rawTruncated: input.rawTruncated,
  }
}

/**
 * Billable usage in the shape snapshots price, or nothing. Every count the
 * price formula reads must be known: reported input and output tokens and a
 * known search count (reported or counted from the response's own events).
 * Approximate or unknown tokens, or an unknown search count, leave usage
 * unset, so a stored row reads "not reported" and a search fee is never
 * priced from a zero nobody measured.
 *
 * No answer service reports a cached-input split, so cache counts are 0 and
 * every input token is priced at the uncached rate: the estimate can only err
 * high, never low.
 */
export function providerUsageFromEvidence(evidence: AnswerEvidence): ProviderUsage | undefined {
  const { tokens, searches } = evidence.usage
  if (tokens.basis !== 'reported' || tokens.input === null || tokens.output === null) return undefined
  if (searches.basis === 'unknown' || searches.count === null) return undefined
  return {
    inputTokens: tokens.input,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: tokens.output,
    searchCount: searches.count,
  }
}

/** The raw result every workflow reads. A served model is recorded only for a disclosed foundation model. */
export function rawQueryResult(input: {
  evidence: AnswerEvidence
  answerText: string
  raw: Record<string, unknown>
}): RawQueryResult {
  const { evidence } = input
  const servedModel = evidence.identity.disclosedModelKind === DisclosedModelKinds['foundation-model']
    ? normalizeServedModel(evidence.identity.disclosedModel)
    : undefined
  const usage = providerUsageFromEvidence(evidence)
  return {
    provider: evidence.identity.route,
    rawResponse: input.raw,
    model: evidence.identity.profile,
    ...(servedModel ? { servedModel } : {}),
    answerText: input.answerText,
    groundingSources: groundingSourcesFromEvidence(evidence.sources),
    searchQueries: evidence.searchQueries,
    retrievalStatus: evidence.retrievalStatus,
    retrievalContract: RetrievalContracts['service-native-v1'],
    ...(usage ? { usage } : {}),
    ...(evidence.completion.finishReason ? { stopReason: evidence.completion.finishReason } : {}),
    evidence,
    citationMeasurable: evidence.citationMeasurable,
  }
}
