import { z } from 'zod'
import { locationContextSchema, type LocationContext } from './provider.js'
import { RetrievalStatuses, retrievalStatusSchema, type RetrievalStatus } from './retrieval.js'
import type { GroundingSource } from './run.js'
import { hostOf, registrableDomain } from './url-normalize.js'

/**
 * Vendor-neutral evidence for one grounded answer. Every hosted answer service
 * (and later any provider) describes what it returned in these terms, so a
 * reader never needs a vendor's field names to tell a search result from a
 * citation, a partial answer from a complete one, or an estimate from a bill.
 *
 * Unknown stays unknown: a count, a model or a cost the upstream did not
 * disclose is `null` with an `unknown` basis, never zero and never copied from
 * what Canonry asked for.
 */

/**
 * How a source relates to the answer, as the upstream documents it.
 *
 * - `search-result`     returned by a search the service ran; not tied to the answer
 * - `page-read`         a page the service opened while working
 * - `answer-support`    documented as used to write the answer, without a marker in the text
 * - `explicit-citation` referenced from the answer itself (an annotation, a marker or a span)
 */
export const sourceRelationshipSchema = z.enum(['search-result', 'page-read', 'answer-support', 'explicit-citation'])
export type SourceRelationship = z.infer<typeof sourceRelationshipSchema>
export const SourceRelationships = sourceRelationshipSchema.enum

/** The relationships that count as the answer citing a source. Nothing else feeds `citedDomains`. */
export const CITATION_ELIGIBLE_RELATIONSHIPS = ['answer-support', 'explicit-citation'] as const satisfies readonly SourceRelationship[]

export function isCitationEligibleRelationship(relationship: SourceRelationship): boolean {
  return (CITATION_ELIGIBLE_RELATIONSHIPS as readonly SourceRelationship[]).includes(relationship)
}

/** Upper bound on one stored excerpt, so one source cannot carry a whole page. */
export const ANSWER_SOURCE_EXCERPT_MAX_CHARS = 2000
/** Upper bound on the excerpts stored for one source. */
export const ANSWER_SOURCE_MAX_EXCERPTS = 20

export const answerSourceSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  /** Offsets as the upstream reported them, against its own answer text. */
  basis: z.literal('upstream'),
}).refine(span => span.end >= span.start, 'span end must not precede its start')
export type AnswerSourceSpan = z.infer<typeof answerSourceSpanSchema>

export const answerSourceSchema = z.object({
  url: z.string().min(1),
  title: z.string().nullable(),
  relationship: sourceRelationshipSchema,
  /** Upstream order, 1-based, when the upstream ranks its sources. */
  rank: z.number().int().positive().nullable(),
  /** Citation markers that point at this source (for example `[1]`). */
  citationNumbers: z.array(z.number().int().nonnegative()).optional(),
  spans: z.array(answerSourceSpanSchema).optional(),
  /**
   * Passages the upstream returned for this source (snippets, supporting
   * excerpts), verbatim and in upstream order, one item per passage so their
   * boundaries survive. The shared layer caps their number and length; the
   * full text stays in the raw response.
   */
  excerpts: z.array(z.string().max(ANSWER_SOURCE_EXCERPT_MAX_CHARS)).max(ANSWER_SOURCE_MAX_EXCERPTS).optional(),
  /** Set when the cap shortened or dropped any excerpt, so a stored excerpt never passes for the whole passage. */
  excerptsTruncated: z.boolean().optional(),
  publishedAt: z.string().nullable(),
  upstreamId: z.string().nullable(),
  /** The upstream's own status for this record, verbatim (for example a failed page read). */
  status: z.string().nullable().optional(),
})
export type AnswerSource = z.infer<typeof answerSourceSchema>

/**
 * Whether the upstream finished.
 *
 * - `complete` the answer is final
 * - `partial`  text exists but the upstream stopped early (length limit, filter, stream cut)
 * - `failed`   the upstream reported a failure
 * - `pending`  an upstream job exists and has not finished; its id is the only result
 *
 * Only `complete` is ever stored as a measured answer.
 */
export const completionStatusSchema = z.enum(['complete', 'partial', 'failed', 'pending'])
export type CompletionStatus = z.infer<typeof completionStatusSchema>
export const CompletionStatuses = completionStatusSchema.enum

export const completionSchema = z.object({
  status: completionStatusSchema,
  finishReason: z.string().nullable(),
  upstreamStatus: z.string().nullable(),
  upstreamRequestId: z.string().nullable(),
  /** The handle a job-based service returns; required to resume, never to resubmit. */
  upstreamJobId: z.string().nullable(),
  error: z.string().nullable(),
}).superRefine((value, ctx) => {
  if (value.status === CompletionStatuses.pending && value.upstreamJobId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['upstreamJobId'], message: 'a pending completion must keep the upstream job id' })
  }
})
export type Completion = z.infer<typeof completionSchema>

export const tokenUsageBasisSchema = z.enum(['reported', 'approximate', 'unknown'])
export type TokenUsageBasis = z.infer<typeof tokenUsageBasisSchema>
export const countBasisSchema = z.enum(['reported', 'derived-from-evidence', 'unknown'])
export type CountBasis = z.infer<typeof countBasisSchema>
export const costBasisSchema = z.enum(['reported', 'estimated', 'unknown'])
export type CostBasis = z.infer<typeof costBasisSchema>
export const CostBases = costBasisSchema.enum

const nullableCount = z.number().int().nonnegative().nullable()

const observedCountSchema = z.object({ count: nullableCount, basis: countBasisSchema })
  .refine(value => (value.basis === 'unknown') === (value.count === null), 'an unknown count is null and a known count has a basis')

export const usageObservationSchema = z.object({
  tokens: z.object({
    input: nullableCount,
    output: nullableCount,
    reasoning: nullableCount,
    basis: tokenUsageBasisSchema,
  }).refine(value => value.basis !== 'unknown' || (value.input === null && value.output === null && value.reasoning === null), 'unknown tokens carry no counts'),
  searches: observedCountSchema,
  pageReads: observedCountSchema,
  /** Billing units the upstream reported (requests, credits, ...), verbatim. */
  billedUnits: z.array(z.object({
    unit: z.enum(['request', 'credit', 'search', 'token']),
    quantity: z.number().nonnegative(),
    basis: z.literal('reported'),
  })),
  cost: z.object({
    /** Integer micro-USD. Null exactly when the basis is unknown: an unknown cost is never zero. */
    micros: z.number().int().nonnegative().nullable(),
    currency: z.literal('USD'),
    basis: costBasisSchema,
    estimatedBy: z.enum(['provider', 'canonry']).nullable(),
  }).superRefine((value, ctx) => {
    if ((value.basis === CostBases.unknown) !== (value.micros === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['micros'], message: 'cost micros are null exactly when the basis is unknown' })
    }
    if ((value.basis === CostBases.estimated) !== (value.estimatedBy !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['estimatedBy'], message: 'only an estimated cost names who estimated it' })
    }
  }),
})
export type UsageObservation = z.infer<typeof usageObservationSchema>

/**
 * Whether a disclosed model names a model, a product tier, or nothing usable.
 * Only a `foundation-model` disclosure may ever become a stored `servedModel`.
 */
export const disclosedModelKindSchema = z.enum(['foundation-model', 'service-tier', 'unknown'])
export type DisclosedModelKind = z.infer<typeof disclosedModelKindSchema>
export const DisclosedModelKinds = disclosedModelKindSchema.enum

export const executionSettingValueSchema = z.union([z.string(), z.number(), z.boolean()])

/** Who answered and under which frozen settings. Requested and disclosed identity stay separate. */
export const executionIdentitySchema = z.object({
  /** Credential, quota and gate owner (for example the service id). */
  connection: z.string().min(1),
  /** The provider key results are stored under (`<service>:<profile>`). */
  route: z.string().min(1),
  service: z.string().min(1),
  product: z.string().min(1),
  profile: z.string().min(1),
  /** The frozen request knobs (effort, depth, result counts), as sent. */
  settings: z.record(z.string(), executionSettingValueSchema),
  requestedServiceModel: z.string().nullable(),
  disclosedModel: z.string().nullable(),
  disclosedModelKind: disclosedModelKindSchema.nullable(),
  /** Version of the request shape Canonry sent for this profile. */
  requestPolicy: z.string().min(1),
  /** Version of the parser that read the response. */
  parserVersion: z.string().min(1),
})
export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>

export const locationGranularitySchema = z.enum(['none', 'country', 'full'])
export type LocationGranularity = z.infer<typeof locationGranularitySchema>
export const locationStrengthSchema = z.enum(['filter', 'hint'])
export type LocationStrength = z.infer<typeof locationStrengthSchema>

export const sentLocationSchema = z.object({
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  timezone: z.string().optional(),
})
export type SentLocation = z.infer<typeof sentLocationSchema>

/**
 * What happened to the requested location. `applied` means every requested
 * field reached the request; `partial` that only some did (for example a
 * country-only service given a city); `ignored` that none did.
 */
export const locationTreatmentStatusSchema = z.enum(['applied', 'partial', 'ignored', 'not-requested'])
export type LocationTreatmentStatus = z.infer<typeof locationTreatmentStatusSchema>
export const LocationTreatmentStatuses = locationTreatmentStatusSchema.enum

export const locationTreatmentSchema = z.object({
  requested: locationContextSchema.nullable(),
  sent: sentLocationSchema.nullable(),
  strength: locationStrengthSchema.nullable(),
  /** A location the service documents applying when none is sent. */
  serviceDefault: z.object({ country: z.string().optional() }).nullable(),
  status: locationTreatmentStatusSchema,
})
export type LocationTreatment = z.infer<typeof locationTreatmentSchema>

/**
 * Which relationship a citation measurement reads. `none` means the service
 * never ties sources to its answer, so citations cannot be measured at all.
 */
export const citationBasisSchema = z.enum(['explicit-citation', 'answer-support', 'mixed', 'none'])
export type CitationBasis = z.infer<typeof citationBasisSchema>
export const CitationBases = citationBasisSchema.enum

export const ANSWER_EVIDENCE_VERSION = 1

export const answerEvidenceSchema = z.object({
  version: z.literal(ANSWER_EVIDENCE_VERSION),
  identity: executionIdentitySchema,
  completion: completionSchema,
  usage: usageObservationSchema,
  sources: z.array(answerSourceSchema),
  /** Search queries the upstream reported running, verbatim. */
  searchQueries: z.array(z.string()),
  retrievalStatus: retrievalStatusSchema,
  citationBasis: citationBasisSchema,
  citationMeasurable: z.boolean(),
  /**
   * Whether source URLs point at the page itself rather than a redirect or
   * tracking link, as the service documents. Only direct URLs are stored as
   * the cited page URLs.
   */
  directSourceUrls: z.boolean(),
  location: locationTreatmentSchema,
  /** The stored raw response was cut at the size cap. */
  rawTruncated: z.boolean(),
}).refine(value => value.citationMeasurable === (value.citationBasis !== CitationBases.none), {
  message: 'citations are measurable exactly when the citation basis is not none',
  path: ['citationMeasurable'],
})
export type AnswerEvidence = z.infer<typeof answerEvidenceSchema>

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return hostOf(url.href) ? url.href : null
  } catch {
    return null
  }
}

/** Sources the answer cites: eligible relationship, a valid http(s) URL, first occurrence of each URL. */
export function citationEligibleSources(sources: readonly AnswerSource[]): AnswerSource[] {
  const seen = new Set<string>()
  const eligible: AnswerSource[] = []
  for (const source of sources) {
    if (!isCitationEligibleRelationship(source.relationship)) continue
    const url = httpUrl(source.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    eligible.push({ ...source, url })
  }
  return eligible
}

/**
 * Whether an answer's cited sources may be stored as the cited page URLs:
 * citations are measurable and the service documents its URLs as the pages
 * themselves. Redirect or tracking links are never stored as cited pages.
 */
export function hasDirectCitedUrls(evidence: Pick<AnswerEvidence, 'citationMeasurable' | 'directSourceUrls'>): boolean {
  return evidence.citationMeasurable && evidence.directSourceUrls
}

/**
 * Sources within the stored excerpt bounds: at most
 * {@link ANSWER_SOURCE_MAX_EXCERPTS} excerpts of at most
 * {@link ANSWER_SOURCE_EXCERPT_MAX_CHARS} characters each. A source the cap
 * changed is marked `excerptsTruncated`; one it left alone is returned as is.
 */
export function clampAnswerSourceExcerpts(sources: readonly AnswerSource[]): AnswerSource[] {
  // The schema bound counts UTF-16 units; never cut a surrogate pair in half.
  const clampText = (text: string): string => {
    if (text.length <= ANSWER_SOURCE_EXCERPT_MAX_CHARS) return text
    const cut = text.slice(0, ANSWER_SOURCE_EXCERPT_MAX_CHARS)
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
  }
  return sources.map(source => {
    if (!source.excerpts) return source
    const kept = source.excerpts.slice(0, ANSWER_SOURCE_MAX_EXCERPTS)
    const clamped = kept.map(clampText)
    const changed = kept.length !== source.excerpts.length || clamped.some((excerpt, index) => excerpt !== kept[index])
    return changed ? { ...source, excerpts: clamped, excerptsTruncated: true } : source
  })
}

/** Registrable domains of the cited sources only, in first-seen order. Search results never count. */
export function deriveCitedDomains(sources: readonly AnswerSource[]): string[] {
  const domains = new Set<string>()
  for (const source of citationEligibleSources(sources)) {
    const host = hostOf(source.url)
    if (host) domains.add(registrableDomain(host) || host)
  }
  return [...domains]
}

/**
 * The legacy `groundingSources` shape, built from cited sources only, so a
 * reader of the old column never mistakes a search result for a citation.
 */
export function groundingSourcesFromEvidence(sources: readonly AnswerSource[]): GroundingSource[] {
  return citationEligibleSources(sources).map(source => ({ uri: source.url, title: source.title?.trim() || hostOf(source.url) || source.url }))
}

/** The citation basis a set of declared relationships supports. */
export function citationBasisFor(relationships: readonly SourceRelationship[]): CitationBasis {
  const explicit = relationships.includes(SourceRelationships['explicit-citation'])
  const support = relationships.includes(SourceRelationships['answer-support'])
  if (explicit && support) return CitationBases.mixed
  if (explicit) return CitationBases['explicit-citation']
  if (support) return CitationBases['answer-support']
  return CitationBases.none
}

/**
 * How a service exposes retrieval: `events` when every search appears as an
 * event, `sources` when only returned sources reveal it, `none` when nothing does.
 */
export const retrievalObservabilitySchema = z.enum(['events', 'sources', 'none'])
export type RetrievalObservability = z.infer<typeof retrievalObservabilitySchema>

/**
 * Whether retrieval ran. Any source, search event or reported search proves
 * it did. Absence proves it did not only for a complete response from a
 * service that reports every search as an event; otherwise it stays unknown.
 */
export function deriveRetrievalStatus(input: {
  sources: readonly AnswerSource[]
  searchEventCount: number
  reportedSearchCount: number | null
  observability: RetrievalObservability
  completion: Pick<Completion, 'status'>
}): RetrievalStatus {
  if (input.sources.length > 0 || input.searchEventCount > 0 || (input.reportedSearchCount ?? 0) > 0) return RetrievalStatuses.used
  return input.observability === 'events' && input.completion.status === CompletionStatuses.complete
    ? RetrievalStatuses['not-used']
    : RetrievalStatuses.unknown
}

/**
 * What a service can do with a requested location, given its declared
 * granularity. Every LocationContext names a city and region, so a
 * country-only service applies part of it and says so.
 */
export function resolveLocationTreatment(
  requested: LocationContext | null | undefined,
  capability: { granularity: LocationGranularity; strength: LocationStrength | null },
  serviceDefault: { country?: string } | null = null,
): LocationTreatment {
  if (!requested) {
    return { requested: null, sent: null, strength: null, serviceDefault, status: LocationTreatmentStatuses['not-requested'] }
  }
  switch (capability.granularity) {
    case 'none':
      return { requested, sent: null, strength: null, serviceDefault, status: LocationTreatmentStatuses.ignored }
    case 'country':
      return { requested, sent: { country: requested.country }, strength: capability.strength, serviceDefault, status: LocationTreatmentStatuses.partial }
    case 'full':
      return {
        requested,
        sent: { country: requested.country, region: requested.region, city: requested.city, ...(requested.timezone ? { timezone: requested.timezone } : {}) },
        strength: capability.strength,
        serviceDefault,
        status: LocationTreatmentStatuses.applied,
      }
  }
}

const SENT_LOCATION_FIELDS = ['country', 'region', 'city', 'timezone'] as const satisfies readonly (keyof SentLocation)[]

/**
 * The location treatment a request actually carries. `offered` is what the
 * profile's granularity allows ({@link resolveLocationTreatment}); `sent` is
 * what the request builder reports it put in the request, in Canonry's field
 * names (a vendor may encode a value differently, so values are kept as the
 * builder reports them). The status comes from the fields sent, never from
 * the granularity alone: a builder that drops a country its vendor cannot
 * take records the location as ignored, not applied.
 *
 * Throws when the builder reports a field the profile does not offer, or a
 * location nobody requested: that is a vendor bug, never something to store.
 */
export function finalizeLocationTreatment(offered: LocationTreatment, sent: SentLocation | null): LocationTreatment {
  const sentFields = SENT_LOCATION_FIELDS.filter(field => typeof sent?.[field] === 'string' && sent[field]!.trim() !== '')
  if (offered.requested === null) {
    if (sentFields.length > 0) throw new Error('The request carries a location although none was requested.')
    return offered
  }
  const unoffered = sentFields.filter(field => offered.sent?.[field] === undefined)
  if (unoffered.length > 0) throw new Error(`The request carries location fields this profile does not offer: ${unoffered.join(', ')}.`)
  if (sentFields.length === 0) return { ...offered, sent: null, strength: null, status: LocationTreatmentStatuses.ignored }
  const requestedFields = SENT_LOCATION_FIELDS.filter(field => typeof offered.requested?.[field] === 'string' && offered.requested[field]!.trim() !== '')
  const kept = Object.fromEntries(sentFields.map(field => [field, sent![field]!])) as SentLocation
  const status = requestedFields.every(field => sentFields.includes(field)) ? LocationTreatmentStatuses.applied : LocationTreatmentStatuses.partial
  return { ...offered, sent: kept, status }
}

/** Usage with nothing disclosed: every count and the cost are unknown, never zero. */
export function unknownUsageObservation(): UsageObservation {
  return {
    tokens: { input: null, output: null, reasoning: null, basis: 'unknown' },
    searches: { count: null, basis: 'unknown' },
    pageReads: { count: null, basis: 'unknown' },
    billedUnits: [],
    cost: { micros: null, currency: 'USD', basis: 'unknown', estimatedBy: null },
  }
}

/** Only a complete observation is a measured answer. */
export function isObservationComplete(evidence: Pick<AnswerEvidence, 'completion'>): boolean {
  return evidence.completion.status === CompletionStatuses.complete
}

/** Convert a USD amount the upstream reported into integer micro-USD, or null when it is not a usable number. */
export function usdToMicros(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value * 1_000_000)
}

/**
 * Who stands behind a recorded cost, in plain words, from its basis and, for
 * an estimate, who made it. One label for the dashboard, the CLI and MCP.
 */
export function answerCostBasisLabel(cost: Pick<UsageObservation['cost'], 'basis' | 'estimatedBy'>): string {
  switch (cost.basis) {
    case CostBases.reported:
      return 'Reported by the service'
    case CostBases.estimated:
      return cost.estimatedBy === 'canonry' ? 'Estimated by Canonry' : 'Estimated by the service'
    case CostBases.unknown:
      return 'Not reported'
  }
}

/** Whether the upstream finished, in plain words, for the dashboard, the CLI and MCP. */
export function answerCompletionLabel(status: CompletionStatus): string {
  switch (status) {
    case CompletionStatuses.complete:
      return 'Complete'
    case CompletionStatuses.partial:
      return 'Partial'
    case CompletionStatuses.failed:
      return 'Failed'
    case CompletionStatuses.pending:
      return 'Upstream job not finished'
  }
}
