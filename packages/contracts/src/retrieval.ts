import { z } from 'zod'

/**
 * Whether retrieval ran for an answer, recorded separately from whether the
 * answer cited anything. A searched-but-uncited answer and an answer written
 * with no retrieval at all both store zero cited domains and zero mentions;
 * only this field separates them, and without it the second kind silently
 * enters the denominator of every visibility rate as a genuine miss.
 *
 * Deliberately NOT derived from, and not a restatement of, `captureStatus`.
 * That signal reports whether citation extraction completed: an extraction that
 * ran and found zero sources is legitimately `complete` and says nothing about
 * whether a search happened. The two are orthogonal and must stay so.
 *
 * - `used`           the response carries a retrieval call
 * - `not-used`       the response is intact and carries no retrieval call
 * - `unknown`        not determinable, because the response is empty or absent
 *                    or because this provider has no detection implemented yet.
 *                    Never collapse this into `not-used`, which would assert an
 *                    absence that was never observed
 * - `not-applicable` the surface has no retrieval step to report
 */
export const retrievalStatusSchema = z.enum([
  'used',
  'not-used',
  'unknown',
  'not-applicable',
])
export type RetrievalStatus = z.infer<typeof retrievalStatusSchema>
export const RetrievalStatuses = retrievalStatusSchema.enum

/**
 * The search policy a result was produced under. Recorded on every snapshot so
 * that a change in search policy can never yield an unmarked row, and so trends
 * spanning a policy change cannot silently mix methods.
 *
 * Unlike {@link RetrievalStatus} this is not an observation. It is a
 * declaration of how the request was constructed, so it is always knowable.
 *
 * - `native-auto-v1`     unmodified query, provider left to decide whether to
 *                        retrieve. Measures whatever the surface chooses to do
 * - `search-required-v1` unmodified query, no system prompt, retrieval required
 *                        through a provider API control. Measures a
 *                        search-grounded answer. NOT a reproduction of any
 *                        consumer product, whose system instructions, routing,
 *                        and search policy are not public
 */
export const retrievalContractSchema = z.enum([
  'native-auto-v1',
  'search-required-v1',
])
export type RetrievalContract = z.infer<typeof retrievalContractSchema>
export const RetrievalContracts = retrievalContractSchema.enum

/**
 * Rows written before retrieval was recorded carry no contract. The policy that
 * produced them varied by provider and release (OpenAI requests already forced
 * search, but early releases also wrapped the query in a prompt), nothing in
 * the store says which release wrote a row, and inventing a value would launder
 * an assumption into an observation. Readers must treat a null contract as
 * "predates the field".
 */
export const RETRIEVAL_CONTRACT_UNRECORDED = null
