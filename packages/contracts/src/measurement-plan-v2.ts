import { z } from 'zod'
import { locationContextSchema, providerNameSchema } from './provider.js'
import { queryClassFilterSchema, queryClassSchema } from './query-class.js'
import { hostOf } from './url-normalize.js'

/**
 * Schema v2 adds Branded/Non-brand assignments, frozen group competitors and a
 * review guard over the compiled document. v1 stays frozen and displayable;
 * `parseStoredMeasurementPlan` dispatches on this literal.
 */
export const MEASUREMENT_PLAN_V2_SCHEMA_VERSION = 2 as const

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)
const measurementV2QueryIdSchema = z.string().trim().min(1).max(256)
const pathCaseSchema = z.enum(['sensitive', 'insensitive'])

/**
 * Structurally identical to `measurementStableKeySchema`, declared here rather
 * than imported: `measurement-plan.ts` imports this module for its stored-plan
 * dispatch, and importing back would close a module cycle that evaluates zod
 * schemas before they exist. The v2 contract test pins the two to the same
 * accept/reject set so they cannot drift apart.
 */
export const measurementV2StableKeySchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][\w.~-]*$/i, 'Must be a URL-safe stable key')

const competitorDomainSchema = z.string().trim().min(1)
  .refine(value => hostOf(value) !== null, 'A competitor domain must be a valid hostname')

/**
 * A stored matcher is already canonical — the compiler normalized it before the
 * revision was frozen — so the decoder checks shape rather than re-running
 * normalization over bytes that must never change. The field set matches
 * `MeasurementTargetUrlMatcher` so v1 and v2 Targets resolve through the same
 * attribution precedence.
 */
export const measurementV2UrlMatcherSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exact'),
    url: z.string().min(1),
    pathCase: pathCaseSchema,
  }).strict(),
  z.object({
    kind: z.literal('prefix'),
    host: z.string().min(1),
    pathPrefix: z.string().min(1),
    pathCase: pathCaseSchema,
  }).strict(),
  z.object({
    kind: z.literal('host'),
    host: z.string().min(1),
  }).strict(),
])
export type MeasurementV2UrlMatcher = z.output<typeof measurementV2UrlMatcherSchema>

/** Revision-frozen project identity. Live project config never rewrites a published revision. */
export const measurementV2ProjectBrandSchema = z.object({
  canonicalHost: z.string().min(1),
  ownedHosts: z.array(z.string().min(1)),
  names: z.array(z.string().min(1)),
}).strict()

export const measurementV2IdentitiesSchema = z.object({
  projectBrand: measurementV2ProjectBrandSchema,
}).strict()
export type MeasurementV2Identities = z.output<typeof measurementV2IdentitiesSchema>

export const measurementV2TargetSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  aliases: z.array(z.string().min(1)),
  urlMatchers: z.array(measurementV2UrlMatcherSchema),
  /** An aliasless Target can be cited but never mentioned; the flag keeps that out of a 0% reading. */
  mentionNotApplicable: z.boolean(),
  /** Set only on a discovered Target. Rebinding preserves it, so history follows the identity. */
  discoveryIdentity: z.string().min(1).nullable(),
}).strict()
export type MeasurementV2Target = z.output<typeof measurementV2TargetSchema>

export const measurementV2CompetitorSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  domain: competitorDomainSchema,
  aliases: z.array(z.string().min(1)),
}).strict()
export type MeasurementV2Competitor = z.output<typeof measurementV2CompetitorSchema>

/** Reporting membership and competitors only: a group never holds queries or execution context. */
export const measurementV2GroupSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  targetKeys: z.array(measurementV2StableKeySchema),
  competitors: z.array(measurementV2CompetitorSchema),
}).strict()
export type MeasurementV2Group = z.output<typeof measurementV2GroupSchema>

export const measurementV2QueryProvenanceSourceSchema = z.enum(['manual', 'query-set', 'template', 'discovery'])
export type MeasurementV2QueryProvenanceSource = z.output<typeof measurementV2QueryProvenanceSourceSchema>

/** Where the frozen question came from, so a later reader can explain the basket without the live assets. */
export const measurementV2QueryProvenanceSchema = z.object({
  source: measurementV2QueryProvenanceSourceSchema,
  sourceId: z.string().min(1).nullable(),
  capturedAt: z.string().datetime(),
}).strict()

export const measurementV2QuerySnapshotSchema = z.object({
  queryId: measurementV2QueryIdSchema,
  queryText: z.string().min(1),
  provenance: measurementV2QueryProvenanceSchema,
}).strict()
export type MeasurementV2QuerySnapshot = z.output<typeof measurementV2QuerySnapshotSchema>

/** The dedup identity: one provider request per unique query + context + provider slot. */
export const measurementV2ExecutionContextSchema = z.object({
  providers: z.array(providerNameSchema).min(1),
  models: z.record(providerNameSchema, z.string().min(1)),
  location: locationContextSchema.nullable(),
}).strict()
export type MeasurementV2ExecutionContext = z.output<typeof measurementV2ExecutionContextSchema>

export const measurementV2ExecutionNodeSchema = z.object({
  stableKey: z.string().min(1),
  queryId: measurementV2QueryIdSchema,
  queryText: z.string().min(1),
  context: measurementV2ExecutionContextSchema,
  expectedSnapshots: z.number().int().nonnegative(),
}).strict()
export type MeasurementV2ExecutionNode = z.output<typeof measurementV2ExecutionNodeSchema>

/**
 * Published classes are exhaustive: an unclassified assignment never survives
 * publish validation. The enum itself is the project-wide `queryClassSchema` —
 * measurement must not drift from the class the read-time surfaces classify by.
 */
export const measurementQueryClassSchema = queryClassSchema
export type MeasurementQueryClass = z.output<typeof measurementQueryClassSchema>

export const measurementV2AssignmentSchema = z.object({
  targetKey: measurementV2StableKeySchema,
  queryId: measurementV2QueryIdSchema,
  queryClass: measurementQueryClassSchema,
  executionNodeKey: z.string().min(1),
}).strict()
export type MeasurementV2Assignment = z.output<typeof measurementV2AssignmentSchema>

/** Target reuse of one execution node adds an edge, never a second provider call. */
export const measurementV2UsageEdgeSchema = z.object({
  executionNodeKey: z.string().min(1),
  targetKey: measurementV2StableKeySchema,
  queryId: measurementV2QueryIdSchema,
}).strict()
export type MeasurementV2UsageEdge = z.output<typeof measurementV2UsageEdgeSchema>

/** Frozen persisted v2 decoder. */
export const measurementPlanV2Schema = z.object({
  schemaVersion: z.literal(MEASUREMENT_PLAN_V2_SCHEMA_VERSION),
  identities: measurementV2IdentitiesSchema,
  targets: z.array(measurementV2TargetSchema),
  groups: z.array(measurementV2GroupSchema),
  querySnapshots: z.array(measurementV2QuerySnapshotSchema),
  assignments: z.array(measurementV2AssignmentSchema),
  executionNodes: z.array(measurementV2ExecutionNodeSchema),
  usageEdges: z.array(measurementV2UsageEdgeSchema),
  /**
   * The review guard, distinct from `measurement_plan_versions.checksum`. It
   * excludes storage ids, timestamps, revision and itself, so the same content
   * at two revisions compares equal and a revert is expressible.
   */
  compiledChecksum: sha256HexSchema,
}).strict().superRefine((plan, ctx) => {
  // Referential integrity is checked here rather than left to each reader.
  // A usage edge pointing at a node that is missing, or at one of two nodes
  // sharing a key, does not fail loudly downstream: the runner dedups by slot
  // identity and simply skips the loser, so the edge's Target is silently never
  // measured. A Target that quietly drops out of a sweep is exactly the kind of
  // wrong number this model exists to prevent, so a revision that could produce
  // one must not decode at all.
  const nodeKeys = new Set<string>()
  for (const node of plan.executionNodes) {
    if (nodeKeys.has(node.stableKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executionNodes'],
        message: `Duplicate execution node key "${node.stableKey}"`,
      })
    }
    nodeKeys.add(node.stableKey)
  }

  const targetKeys = new Set(plan.targets.map(target => target.stableKey))

  plan.usageEdges.forEach((edge, index) => {
    if (!nodeKeys.has(edge.executionNodeKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usageEdges', index, 'executionNodeKey'],
        message: `Usage edge references unknown execution node "${edge.executionNodeKey}"`,
      })
    }
    if (!targetKeys.has(edge.targetKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usageEdges', index, 'targetKey'],
        message: `Usage edge references unknown Target "${edge.targetKey}"`,
      })
    }
  })

  plan.assignments.forEach((assignment, index) => {
    if (!targetKeys.has(assignment.targetKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assignments', index, 'targetKey'],
        message: `Assignment references unknown Target "${assignment.targetKey}"`,
      })
    }
  })

  for (const group of plan.groups) {
    for (const targetKey of group.targetKeys) {
      if (!targetKeys.has(targetKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['groups'],
          message: `Group "${group.stableKey}" references unknown Target "${targetKey}"`,
        })
      }
    }
  }
})
export type MeasurementPlanV2 = z.output<typeof measurementPlanV2Schema>

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Private copy of the v1 canonicalizer: this module must not import back into `measurement-plan.ts`. */
function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    )
  }
  return value
}

function matcherOrderKey(matcher: MeasurementV2UrlMatcher): string {
  switch (matcher.kind) {
    case 'exact': return ['exact', matcher.url, '', matcher.pathCase].join('\u0000')
    case 'prefix': return ['prefix', matcher.host, matcher.pathPrefix, matcher.pathCase].join('\u0000')
    case 'host': return ['host', matcher.host, '', ''].join('\u0000')
  }
}

/**
 * Total order over every component of a revision, not only the assignment list.
 * The dedup identity includes the provider set and the model map, so an
 * ordering that left provider configuration alone would let one plan compile to
 * two different checksums on two machines.
 */
export function canonicalMeasurementPlanV2(plan: MeasurementPlanV2): MeasurementPlanV2 {
  return {
    schemaVersion: plan.schemaVersion,
    identities: {
      projectBrand: {
        canonicalHost: plan.identities.projectBrand.canonicalHost,
        ownedHosts: [...plan.identities.projectBrand.ownedHosts].sort(compareText),
        names: [...plan.identities.projectBrand.names].sort(compareText),
      },
    },
    targets: [...plan.targets]
      .map(target => ({
        ...target,
        aliases: [...target.aliases].sort(compareText),
        urlMatchers: [...target.urlMatchers].sort((left, right) => compareText(matcherOrderKey(left), matcherOrderKey(right))),
      }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    groups: [...plan.groups]
      .map(group => ({
        ...group,
        targetKeys: [...group.targetKeys].sort(compareText),
        competitors: [...group.competitors]
          .map(competitor => ({ ...competitor, aliases: [...competitor.aliases].sort(compareText) }))
          .sort((left, right) => compareText(left.stableKey, right.stableKey)),
      }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    querySnapshots: [...plan.querySnapshots].sort((left, right) => compareText(left.queryId, right.queryId)),
    assignments: [...plan.assignments].sort((left, right) => (
      compareText(left.targetKey, right.targetKey)
      || compareText(left.queryId, right.queryId)
      || compareText(left.executionNodeKey, right.executionNodeKey)
    )),
    executionNodes: [...plan.executionNodes]
      .map(node => ({
        ...node,
        context: { ...node.context, providers: [...node.context.providers].sort(compareText) },
      }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    usageEdges: [...plan.usageEdges].sort((left, right) => (
      compareText(left.executionNodeKey, right.executionNodeKey)
      || compareText(left.targetKey, right.targetKey)
      || compareText(left.queryId, right.queryId)
    )),
    compiledChecksum: plan.compiledChecksum,
  }
}

/** Stable, browser-safe serialization of the whole stored document. */
export function canonicalMeasurementPlanV2Json(plan: MeasurementPlanV2): string {
  return JSON.stringify(canonicalJsonValue(canonicalMeasurementPlanV2(plan)))
}

/**
 * The exact bytes `compiledChecksum` is taken over. The checksum field itself
 * is excluded, so hashing a revision and re-hashing what it published agree —
 * and content restored from an older revision compares equal to it.
 */
export function measurementPlanV2ChecksumJson(plan: MeasurementPlanV2): string {
  const { compiledChecksum: _guard, ...rest } = canonicalMeasurementPlanV2(plan)
  return JSON.stringify(canonicalJsonValue(rest))
}

export const MEASUREMENT_PAGE_DEFAULT_LIMIT = 50
export const MEASUREMENT_PAGE_MAX_LIMIT = 100

/** Cursor pagination for collections that must serve a thousand Targets without client-side truncation. */
export function measurementCursorPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().min(1).nullable(),
    totalEstimate: z.number().int().nonnegative().optional(),
  }).strict()
}

export const measurementMetricUnavailableReasonSchema = z.enum([
  'no_completed_run',
  'plan_v1',
  'no_population',
  'evidence_incomplete',
  'not_applicable',
])
export type MeasurementMetricUnavailableReason = z.output<typeof measurementMetricUnavailableReasonSchema>

/**
 * Available and unavailable are deliberately different shapes: an unavailable
 * metric carries no `value` key at all, so nothing downstream can read missing
 * evidence as a numeric zero.
 */
export const measurementMetricValueSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    value: z.number(),
    numerator: z.number().int().nonnegative().optional(),
    denominator: z.number().int().positive().optional(),
    /** Server-computed ratio for count metrics whose `value` remains the count. */
    rate: z.number().min(0).max(1).optional(),
  }).strict(),
  z.object({
    state: z.literal('unavailable'),
    reason: measurementMetricUnavailableReasonSchema,
  }).strict(),
])
export type MetricValue = z.output<typeof measurementMetricValueSchema>

export const measurementOverviewScopeKindSchema = z.enum(['all', 'group', 'property'])
export type MeasurementOverviewScopeKind = z.output<typeof measurementOverviewScopeKindSchema>

export const measurementQueryClassFilterSchema = queryClassFilterSchema
export type MeasurementQueryClassFilter = z.output<typeof measurementQueryClassFilterSchema>

/** A single HTTP-friendly sort token keeps cursors bound to the exact ordering. */
export const measurementOverviewSortSchema = z.enum([
  'label-asc',
  'label-desc',
  'citationCoverage-asc',
  'citationCoverage-desc',
  'mentionCoverage-asc',
  'mentionCoverage-desc',
])
export type MeasurementOverviewSort = z.output<typeof measurementOverviewSortSchema>
export const MEASUREMENT_OVERVIEW_DEFAULT_SORT: MeasurementOverviewSort = 'label-asc'

export const measurementStateSchema = z.enum(['not_measured', 'queued', 'running', 'complete', 'partial', 'failed'])
export type MeasurementState = z.output<typeof measurementStateSchema>

export const measurementNextActionKindSchema = z.enum([
  'run_measurement',
  'review_flags',
  'complete_setup',
  'republish_setup',
  'none',
])
export type MeasurementNextActionKind = z.output<typeof measurementNextActionKindSchema>

/**
 * `runId` is the only way to display a scoped spot check: run selection
 * otherwise falls to the most recent completed run pinned to the active
 * revision. A run pinned to another revision is refused rather than joined.
 */
export const measurementOverviewQuerySchema = z.object({
  scope: measurementOverviewScopeKindSchema,
  groupKey: measurementV2StableKeySchema.optional(),
  targetKey: measurementV2StableKeySchema.optional(),
  queryClass: measurementQueryClassFilterSchema.optional(),
  provider: providerNameSchema.optional(),
  location: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  /** Filters the returned rows only. Metrics are computed before it is applied. */
  search: z.string().optional(),
  /** Omit for the shipped label-ascending order. Metric-unavailable rows sort first. */
  sort: measurementOverviewSortSchema.optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(MEASUREMENT_PAGE_MAX_LIMIT).optional(),
}).strict()
export type MeasurementOverviewQuery = z.output<typeof measurementOverviewQuerySchema>

/**
 * One answer engine's share of a Property's own population.
 *
 * The rates are taken over the slots that engine actually answered, so they do
 * not average back to the Property total and must never be summed into one. An
 * engine that produced no slot for this Property is absent from the array
 * rather than present with a zero.
 */
export const measurementPropertyProviderRowSchema = z.object({
  provider: providerNameSchema,
  mentionCoverage: measurementMetricValueSchema,
  citationCoverage: measurementMetricValueSchema,
}).strict()
export type MeasurementPropertyProviderRow = z.output<typeof measurementPropertyProviderRowSchema>

/**
 * Every Property in a scope, split by which of the two signals it actually got.
 *
 * The buckets are DISJOINT and EXHAUSTIVE, so they always sum to `total` — a UI
 * can state the total beside them and a drift becomes visible rather than
 * quietly wrong. `citedOnly` is called out separately because it is the most
 * actionable group: the engine used the page as a source and still recommended
 * somebody else.
 *
 * A Property is only classified into the four measured buckets when BOTH
 * signals were measured for it. One signal alone cannot support "mentioned but
 * not cited" — that phrasing asserts an absence nothing measured — so a
 * half-measured Property counts as `notMeasured`.
 */
export const measurementOutcomeCountsSchema = z.object({
  bothSignals: z.number().int().nonnegative(),
  mentionedOnly: z.number().int().nonnegative(),
  citedOnly: z.number().int().nonnegative(),
  neither: z.number().int().nonnegative(),
  notMeasured: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()
export type MeasurementOutcomeCounts = z.output<typeof measurementOutcomeCountsSchema>

export const measurementPropertyRowSchema = z.object({
  targetKey: measurementV2StableKeySchema,
  label: z.string().min(1),
  mentionCoverage: measurementMetricValueSchema,
  citationCoverage: measurementMetricValueSchema,
  /** Per-answer-engine split of the same population, in stable provider order. */
  providers: z.array(measurementPropertyProviderRowSchema),
  flags: z.number().int().nonnegative(),
}).strict()
export type MeasurementPropertyRow = z.output<typeof measurementPropertyRowSchema>

export const measurementNamedShareOfVoiceEntrySchema = z.object({
  kind: z.enum(['project', 'competitor']),
  stableKey: z.string().min(1),
  label: z.string().min(1),
  domain: z.string().min(1),
  credits: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
}).strict()

/**
 * Group-only, Non-brand-only. The basis is frozen in the payload so a reader
 * can never mistake it for an all-questions share, and the denominator counts
 * named presence credits rather than unique slots.
 */
export const measurementNamedShareOfVoiceSchema = z.object({
  groupKey: measurementV2StableKeySchema,
  queryClass: z.literal('non-brand'),
  denominator: z.number().int().positive(),
  entries: z.array(measurementNamedShareOfVoiceEntrySchema),
}).strict()
export type NamedShareOfVoice = z.output<typeof measurementNamedShareOfVoiceSchema>

export const measurementOverviewResponseSchema = z.object({
  mode: z.enum(['active-v1', 'active-v2']),
  scope: z.object({
    kind: measurementOverviewScopeKindSchema,
    key: z.string().min(1).optional(),
    label: z.string().min(1),
  }).strict(),
  queryClass: measurementQueryClassFilterSchema,
  measurement: z.object({
    state: measurementStateSchema,
    currentRunId: z.string().min(1).optional(),
    displayedRunId: z.string().min(1).optional(),
    completed: z.number().int().nonnegative(),
    expected: z.number().int().nonnegative(),
    completedAt: z.string().datetime().optional(),
    /** Present for v2 reads. True when the selected run used bridged or recovered historical source data. */
    includesHistoricalData: z.boolean().optional(),
  }).strict(),
  nextAction: z.object({
    kind: measurementNextActionKindSchema,
    count: z.number().int().nonnegative().optional(),
  }).strict(),
  metrics: z.object({
    propertiesMentioned: measurementMetricValueSchema,
    mentionCoverage: measurementMetricValueSchema,
    citationCoverage: measurementMetricValueSchema,
    /** Independent identity presence, not a shared-denominator market share. */
    brandPresence: measurementMetricValueSchema,
    /** @deprecated Identical to brandPresence. Kept until the browser migrates off it. */
    sov: measurementMetricValueSchema.describe(
      'Deprecated alias of brandPresence carrying the identical value. Remove once the browser migrates.',
    ),
  }).strict(),
  properties: measurementCursorPageSchema(measurementPropertyRowSchema),
  /**
   * Outcome split over the whole RESULT SET, not the page — so paging through
   * does not move it. It narrows with `search` exactly as `properties.totalEstimate`
   * does, because both are computed from the same filtered rows; with no search
   * that result set is the entire scope.
   */
  outcomes: measurementOutcomeCountsSchema,
  flags: z.object({ total: z.number().int().nonnegative() }).strict(),
  namedShareOfVoice: measurementNamedShareOfVoiceSchema.optional(),
}).strict()
export type MeasurementOverviewResponse = z.output<typeof measurementOverviewResponseSchema>

/**
 * What one evidence row is.
 *
 * `sources` is one row per cited URL — the published shape, and the only thing
 * a caller written before this parameter existed can read. It can describe a
 * citation and nothing else: an answer that mentioned the Property without
 * linking it has no URL to hang a row on, and an answer that did neither
 * produces no row at all.
 *
 * `answers` is one row per answer the Property was measured on, with the cited
 * URLs nested inside it, so the answers that explain a gap are present rather
 * than missing.
 */
export const measurementEvidenceShapeSchema = z.enum(['sources', 'answers'])
export type MeasurementEvidenceShape = z.output<typeof measurementEvidenceShapeSchema>
export const MeasurementEvidenceShapes = measurementEvidenceShapeSchema.enum
export const MEASUREMENT_EVIDENCE_DEFAULT_SHAPE: MeasurementEvidenceShape = MeasurementEvidenceShapes.sources

/**
 * Source evidence for exactly one Property.
 *
 * `targetKey` is required rather than optional: the whole point of this read is
 * that a Property page must not pull every group and every Target to find its
 * own rows. Run selection matches the overview — the most recent completed run
 * pinned to the active revision unless `runId` names another one.
 */
export const measurementPropertyEvidenceQuerySchema = z.object({
  targetKey: measurementV2StableKeySchema,
  /** Restrict to one question class. Never pooled across classes. */
  queryClass: measurementQueryClassFilterSchema.optional(),
  provider: providerNameSchema.optional(),
  location: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  /** Omit for the published per-URL rows. A cursor is bound to the shape that issued it. */
  shape: measurementEvidenceShapeSchema.optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(MEASUREMENT_PAGE_MAX_LIMIT).optional(),
}).strict()
export type MeasurementPropertyEvidenceQuery = z.output<typeof measurementPropertyEvidenceQuerySchema>
