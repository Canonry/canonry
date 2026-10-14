import { z } from 'zod'
import {
  measurementV2ExecutionContextSchema,
  measurementV2StableKeySchema,
  measurementV2UsageEdgeSchema,
} from './measurement-plan-v2.js'
import { providerNameSchema } from './provider.js'
import { queryClassSchema, type QueryClass } from './query-class.js'
import { visibilityReportScopeOptionSchema } from './visibility-report.js'

/** Expand an authoring template once; execution uses the editable final question verbatim. */
export function expandQueryTemplate(pattern: string, bindings: Readonly<Record<string, string>>): string {
  let output = pattern
  for (const [variable, value] of Object.entries(bindings)) output = output.split(`{${variable}}`).join(value)
  return output.trim()
}

/**
 * A pattern's variable names by what each fills in. The names of one kind are
 * aliases: each binds the same value, and no name ever changes kind, so a
 * saved pattern keeps the name it was written with. `location` is the search
 * location, never the location's name.
 */
export const QUERY_TEMPLATE_VARIABLE_NAMES = {
  market: ['market', 'submarket'],
  locationName: ['locationName', 'property', 'propertyBrand'],
  searchLocation: ['searchLocation', 'location'],
} as const satisfies Record<string, readonly string[]>
export type QueryTemplateVariableKind = keyof typeof QUERY_TEMPLATE_VARIABLE_NAMES

/** What a pattern variable fills in, or null for a name no pattern reader binds. */
export function queryTemplateVariableKind(name: string): QueryTemplateVariableKind | null {
  for (const [kind, names] of Object.entries(QUERY_TEMPLATE_VARIABLE_NAMES)) {
    if ((names as readonly string[]).includes(name)) return kind as QueryTemplateVariableKind
  }
  return null
}

/** One value bound under every name of a kind, so a pattern written with any of them expands. */
export function queryTemplateBindings(kind: QueryTemplateVariableKind, value: string): Record<string, string> {
  return Object.fromEntries(QUERY_TEMPLATE_VARIABLE_NAMES[kind].map(name => [name, value]))
}

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/)
const queryTrackingIdSchema = z.string().trim().min(1).max(256)
const queryTrackingTextSchema = z.string().trim().min(1).max(4_000)
/** Server-minted timestamp for the exact preview the operator reviewed. */
export const queryTrackingReviewedAtSchema = z.string().datetime()

/** Snapshot of every mutable input the query workspace is allowed to publish against. */
export const queryTrackingWorkspaceVersionSchema = z.string().regex(/^qtw_[a-f0-9]{64}$/)
export type QueryTrackingWorkspaceVersion = z.output<typeof queryTrackingWorkspaceVersionSchema>

/** A review token binds a commit to the exact preview body and workspace version. */
export const queryTrackingPreviewTokenSchema = z.string().regex(/^qtp_[a-f0-9]{64}$/)
export type QueryTrackingPreviewToken = z.output<typeof queryTrackingPreviewTokenSchema>

export const queryTrackingModeSchema = z.enum(['simple', 'advanced'])
export type QueryTrackingMode = z.output<typeof queryTrackingModeSchema>

/**
 * The template record is frozen with the expanded question. `output` is not
 * re-expanded when an old revision is read, so a later template edit can never
 * rewrite historical measurement meaning.
 */
export const queryTrackingTemplateProvenanceSchema = z.object({
  templateId: queryTrackingIdSchema,
  templateVersion: z.string().trim().min(1).max(256),
  template: queryTrackingTextSchema,
  bindings: z.record(z.string().trim().min(1).max(128), z.string().trim().min(1).max(128)),
  output: queryTrackingTextSchema,
}).strict()
export type QueryTrackingTemplateProvenance = z.output<typeof queryTrackingTemplateProvenanceSchema>

/**
 * Frozen source metadata carried by a workspace row and a published v2 snapshot.
 * A template row may lack its record: a plan published before query control
 * froze it keeps only the source.
 */
export const queryTrackingProvenanceSchema = z.object({
  source: z.enum(['manual', 'query-set', 'template', 'research', 'discovery']),
  sourceId: queryTrackingIdSchema.nullable(),
  capturedAt: z.string().datetime(),
  template: queryTrackingTemplateProvenanceSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.source !== 'template' && value.template !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['template'], message: 'Only a template query may carry template provenance.' })
  }
})
export type QueryTrackingProvenance = z.output<typeof queryTrackingProvenanceSchema>

/** Manual text is supplied directly; saved sources are resolved server-side and project-scoped. */
export const queryTrackingSourceInputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('manual'),
    text: queryTrackingTextSchema,
  }).strict(),
  z.object({
    source: z.literal('template'),
    templateId: queryTrackingIdSchema,
    templateVersion: z.string().trim().min(1).max(256),
    template: queryTrackingTextSchema,
  }).strict(),
  z.object({
    source: z.literal('research'),
    researchRunQueryId: queryTrackingIdSchema,
  }).strict(),
  z.object({
    source: z.literal('discovery'),
    discoveryProbeId: queryTrackingIdSchema,
  }).strict(),
])
export type QueryTrackingSourceInput = z.output<typeof queryTrackingSourceInputSchema>

/**
 * Groups expand to their current Target membership. Markets are different:
 * their frozen scope membership is a set of exact usage-edge triples.
 */
export const queryTrackingAudienceSchema = z.object({
  targetKeys: z.array(measurementV2StableKeySchema).optional(),
  groupKeys: z.array(measurementV2StableKeySchema).optional(),
  marketKeys: z.array(measurementV2StableKeySchema).optional(),
}).strict()
export type QueryTrackingAudience = z.output<typeof queryTrackingAudienceSchema>

/** A caller names a configured location by label; the server stores the complete frozen context. */
export const queryTrackingContextInputSchema = z.object({
  providers: z.array(providerNameSchema).min(1),
  models: z.record(providerNameSchema, z.string().trim().min(1)),
  location: z.string().trim().min(1).nullable(),
}).strict()
export type QueryTrackingContextInput = z.output<typeof queryTrackingContextInputSchema>

export const queryTrackingAdditionSchema = z.object({
  input: queryTrackingSourceInputSchema,
  audience: queryTrackingAudienceSchema.optional(),
  /** New non-market portfolio assignments must select their full context explicitly. */
  contexts: z.array(queryTrackingContextInputSchema).min(1).optional(),
  /** Omission delegates to the shared server classifier; a supplied class is an operator decision. */
  queryClass: queryClassSchema.optional(),
}).strict()
export type QueryTrackingAddition = z.output<typeof queryTrackingAdditionSchema>

/**
 * Ends pairings; it never deletes an answer. With no `audience`, a query the
 * active plan asks is stopped: its pairings end and its row stays on the list
 * with its answers, `focus.kind` `not-asked`. The same removal of a query that
 * is asked nowhere deletes the row. With an `audience`, only the selected
 * pairings end. A simple basket has no not-asked state: a removal deletes.
 */
export const queryTrackingRemovalSchema = z.object({
  queryId: queryTrackingIdSchema.optional(),
  queryText: queryTrackingTextSchema.optional(),
  audience: queryTrackingAudienceSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.queryId === undefined) === (value.queryText === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of queryId or queryText.' })
  }
})
export type QueryTrackingRemoval = z.output<typeof queryTrackingRemovalSchema>

/** Edit stored assignments in place; the server retains their exact frozen execution edges. */
export const queryTrackingEditSchema = z.object({
  queryId: queryTrackingIdSchema,
  /** Omission selects the whole query. A supplied audience selects existing assignments only. */
  audience: queryTrackingAudienceSchema.optional(),
  /** Resolved question text, never a template to expand again. */
  text: queryTrackingTextSchema.optional(),
  /** Omit to preserve classification; null explicitly asks the server to classify again. */
  queryClass: z.union([queryClassSchema, z.null()]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.text === undefined && value.queryClass === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide query text or a classification change.' })
  }
})
export type QueryTrackingEdit = z.output<typeof queryTrackingEditSchema>

export const queryTrackingMutationSchema = z.object({
  additions: z.array(queryTrackingAdditionSchema),
  removals: z.array(queryTrackingRemovalSchema),
  edits: z.array(queryTrackingEditSchema).optional(),
}).strict()
export type QueryTrackingMutation = z.output<typeof queryTrackingMutationSchema>

export const queryTrackingPreviewRequestSchema = queryTrackingMutationSchema.extend({
  expectedWorkspaceVersion: queryTrackingWorkspaceVersionSchema,
}).strict()
export type QueryTrackingPreviewRequest = z.output<typeof queryTrackingPreviewRequestSchema>

export const queryTrackingCommitRequestSchema = queryTrackingPreviewRequestSchema.extend({
  previewToken: queryTrackingPreviewTokenSchema,
  /** Echo the server-minted preview timestamp; it is part of the review token. */
  reviewedAt: queryTrackingReviewedAtSchema,
}).strict()
export type QueryTrackingCommitRequest = z.output<typeof queryTrackingCommitRequestSchema>

const countSchema = z.number().int().nonnegative()

/** Queries by Type: one class, both (`mixed`), or none (`unknown`). Branded and non-brand are never pooled. */
const queryClassCountsSchema = z.object({
  branded: countSchema,
  nonBrand: countSchema,
  mixed: countSchema,
  unknown: countSchema,
}).strict()

/**
 * A place's own numbers, counted by the server from the tracked rows' `focus`.
 * `answersPerSweep` counts each execution the place uses once, so places
 * sharing an execution do not add up to the project total.
 *
 * `queries` is the distinct queries with a pairing at the place: the rows a
 * list under it shows. `byClass` splits them by the Type of their pairings at
 * that place, read from every plan assignment there, and adds up to `queries`.
 * A query Branded at one location and Non-brand at another is `mixed` for a
 * group or market holding both and one class at each location. Both are
 * optional so a client tolerates a server that predates them.
 */
export const queryTrackingTargetCountsSchema = z.object({
  /** Distinct queries paired with this location. */
  queries: countSchema.optional(),
  byClass: queryClassCountsSchema.optional(),
  /** Rows whose Subject is this location. */
  propertyQueries: countSchema,
  /** Rows whose Subject is a market holding this location. */
  marketQueries: countSchema,
  /** Hand-picked rows paired with this location. */
  customQueries: countSchema,
  answersPerSweep: countSchema,
}).strict()
export type QueryTrackingTargetCounts = z.output<typeof queryTrackingTargetCountsSchema>

export const queryTrackingTargetSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  label: z.string().trim().min(1),
  /** Markets holding a usage edge for this location. Optional, as `counts`, for a server that predates them. */
  marketKeys: z.array(measurementV2StableKeySchema).optional(),
  counts: queryTrackingTargetCountsSchema.optional(),
}).strict()
export type QueryTrackingTarget = z.output<typeof queryTrackingTargetSchema>

export const queryTrackingGroupCountsSchema = z.object({
  /** Distinct queries paired with a member location. */
  queries: countSchema,
  /** Optional, as the three Subject counts below, for a server that predates them. */
  byClass: queryClassCountsSchema.optional(),
  /** Those queries whose Subject is a market. */
  marketQueries: countSchema.optional(),
  /** Those whose Subject is a location. */
  propertyQueries: countSchema.optional(),
  /** Those that are hand-picked. The three add up to `queries`. */
  customQueries: countSchema.optional(),
  /** Distinct markets holding a member location. A market that holds no location counts for no group. */
  markets: countSchema,
  answersPerSweep: countSchema,
}).strict()
export type QueryTrackingGroupCounts = z.output<typeof queryTrackingGroupCountsSchema>

export const queryTrackingGroupSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  parentGroupKey: measurementV2StableKeySchema.optional(),
  label: z.string().trim().min(1),
  targetKeys: z.array(measurementV2StableKeySchema),
  /** Optional so a client tolerates a server that predates it. */
  counts: queryTrackingGroupCountsSchema.optional(),
}).strict()
export type QueryTrackingGroup = z.output<typeof queryTrackingGroupSchema>

export const queryTrackingMarketCountsSchema = z.object({
  /**
   * Distinct queries with a pairing inside this market. A hand-picked query
   * paired here counts, so this can exceed the two Subject counts below.
   */
  queries: countSchema.optional(),
  byClass: queryClassCountsSchema.optional(),
  /** Rows whose Subject is this market. */
  marketQueries: countSchema,
  /** Rows whose Subject is one of this market's locations. */
  propertyQueries: countSchema,
  answersPerSweep: countSchema,
}).strict()
export type QueryTrackingMarketCounts = z.output<typeof queryTrackingMarketCountsSchema>

export const queryTrackingMarketSchema = z.object({
  stableKey: measurementV2StableKeySchema,
  groupKey: measurementV2StableKeySchema.optional(),
  label: z.string().trim().min(1),
  usageEdges: z.array(measurementV2UsageEdgeSchema),
  /** Distinct locations named by `usageEdges`. Optional, as `counts`, for a server that predates them. */
  targetKeys: z.array(measurementV2StableKeySchema).optional(),
  counts: queryTrackingMarketCountsSchema.optional(),
}).strict()
export type QueryTrackingMarket = z.output<typeof queryTrackingMarketSchema>

export const queryTrackingAssignmentSchema = z.object({
  targetKey: measurementV2StableKeySchema,
  groupKeys: z.array(measurementV2StableKeySchema),
  marketKeys: z.array(measurementV2StableKeySchema),
  queryClass: queryClassSchema.nullable(),
  classificationSource: z.enum(['frozen', 'server', 'operator']),
  /** Complete provider/model/location contexts, never a label-only reconstruction. */
  contexts: z.array(measurementV2ExecutionContextSchema).min(1),
}).strict()
export type QueryTrackingAssignment = z.output<typeof queryTrackingAssignmentSchema>

/**
 * A tracked question's Subject, derived from the plan's pairings when the
 * workspace is read and never stored. `property` is shown as Location and
 * `custom` as Hand-picked. `company` is a simple site's whole project.
 */
export const queryTrackingFocusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('market'), key: measurementV2StableKeySchema }).strict(),
  z.object({ kind: z.literal('property'), key: measurementV2StableKeySchema }).strict(),
  z.object({ kind: z.literal('company') }).strict(),
  z.object({ kind: z.literal('custom') }).strict(),
  z.object({ kind: z.literal('not-asked') }).strict(),
])
export type QueryTrackingFocus = z.output<typeof queryTrackingFocusSchema>

/**
 * The Type a Subject takes on an advanced portfolio: a market query is
 * Non-brand and a location query is Branded. A hand-picked query takes either.
 */
export const QUERY_CLASS_BY_FOCUS = {
  market: 'non-brand',
  property: 'branded',
} as const satisfies Partial<Record<QueryTrackingFocus['kind'], QueryClass>>

export const queryTrackingTrackedRowSchema = z.object({
  queryId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  normalizedText: queryTrackingTextSchema,
  provenance: queryTrackingProvenanceSchema.nullable(),
  /** The server resolves measurement availability against the active frozen revision. */
  state: z.enum(['tracked', 'awaiting-sweep']),
  /**
   * When a sweep last measured every pairing as the active plan asks it. A
   * row with no pairing has none to measure: it carries when a whole-project
   * sweep last stored an answer for it, so a stopped query keeps its date.
   */
  lastMeasuredAt: z.string().datetime().nullable(),
  assignments: z.array(queryTrackingAssignmentSchema),
  /** Optional so a client tolerates a server that predates it. This server always sets it. */
  focus: queryTrackingFocusSchema.optional(),
  /**
   * The row's Type: the distinct classes across every plan assignment of the
   * query (one per location and search location), sorted. Two mean mixed, none
   * means not set. `assignments[].queryClass` shows one class per location, so
   * it can list fewer classes. A simple site's row carries the project
   * classifier's one class. Optional like `focus`.
   */
  queryClasses: z.array(queryClassSchema).optional(),
}).strict()
export type QueryTrackingTrackedRow = z.output<typeof queryTrackingTrackedRowSchema>

export const queryTrackingResearchCandidateSchema = z.object({
  researchRunId: queryTrackingIdSchema,
  researchRunQueryId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  createdAt: z.string().datetime(),
}).strict()
export type QueryTrackingResearchCandidate = z.output<typeof queryTrackingResearchCandidateSchema>

export const queryTrackingDiscoveryCandidateSchema = z.object({
  discoverySessionId: queryTrackingIdSchema,
  discoveryProbeId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  createdAt: z.string().datetime(),
}).strict()
export type QueryTrackingDiscoveryCandidate = z.output<typeof queryTrackingDiscoveryCandidateSchema>

/**
 * Workspace totals, counted by the server so no client recounts rows.
 * `byClass` and `byFocus` each add up to `asked`; `asked + notAsked` is the
 * number of tracked rows. Branded and non-brand stay separate counts.
 */
export const queryTrackingSummarySchema = z.object({
  /** Rows with at least one pairing. Every row on a simple site. */
  asked: countSchema,
  notAsked: countSchema,
  /** Asked rows by Type: one class, both (`mixed`), or none (`unknown`). */
  byClass: queryClassCountsSchema,
  /** Asked rows by Subject (`focus.kind`). */
  byFocus: z.object({
    market: countSchema,
    property: countSchema,
    company: countSchema,
    custom: countSchema,
  }).strict(),
  /** Plan assignments, the unit of a diff row's `assignmentCount`. All zero on a simple site. */
  assignments: z.object({
    total: countSchema,
    branded: countSchema,
    nonBrand: countSchema,
    unknown: countSchema,
  }).strict(),
  /** Provider answers one sweep asks for: a no-op preview's `workload.existingProviderCalls`. */
  answersPerSweep: countSchema,
  structure: z.object({
    targets: countSchema,
    markets: countSchema,
    groups: countSchema,
    topLevelGroups: countSchema,
    /** Distinct competitor domains across groups. */
    competitors: countSchema,
  }).strict(),
}).strict()
export type QueryTrackingSummary = z.output<typeof queryTrackingSummarySchema>

/** Distinct queries the plan assigns now and after the change, against the server limit. */
export const queryTrackingLimitsSchema = z.object({
  queries: z.object({
    current: countSchema,
    next: countSchema,
    max: z.number().int().positive(),
    /** `max` minus each count, never below zero. Optional so a client tolerates a server that predates it. */
    left: z.object({
      current: countSchema,
      next: countSchema,
    }).strict().optional(),
    /** Each count minus `max`, never below zero. Optional like `left`. */
    over: z.object({
      current: countSchema,
      next: countSchema,
    }).strict().optional(),
    /**
     * True when a commit of this change is refused: it grows the plan past
     * `max`. A plan already over the limit may still shrink, so `over.next`
     * above zero does not decide it. Always false on a read. Optional like `left`.
     */
    exceeded: z.boolean().optional(),
  }).strict(),
}).strict()
export type QueryTrackingLimits = z.output<typeof queryTrackingLimitsSchema>

/** A market with fewer rows whose Subject is the market than this is thin. */
export const QUERY_TRACKING_THIN_MARKET_FLOOR = 4

/**
 * A saved pattern asked as a market's own query in at least one market and not
 * in another market that holds a location. Only a pattern whose one variable
 * is a market name (`{market}` or `{submarket}`) is read: no other pattern
 * makes a market's own query.
 */
export const queryTrackingPatternGapSchema = z.object({
  templateId: queryTrackingIdSchema,
  /** The saved pattern's name now. Null once the saved pattern was deleted. */
  name: z.string().trim().min(1).nullable(),
  /** The saved pattern's text now, or the newest text its rows froze once it was deleted. */
  pattern: z.string().trim().min(1),
  /**
   * Markets with a row whose Subject is the market and which froze this
   * pattern's record or has the text the pattern makes for the market's label.
   */
  usedMarketKeys: z.array(measurementV2StableKeySchema),
  /** Markets with a location and no such row. A market with no location takes no addition, so it is never missing. */
  missingMarketKeys: z.array(measurementV2StableKeySchema),
}).strict()
export type QueryTrackingPatternGap = z.output<typeof queryTrackingPatternGapSchema>

/**
 * Locations, markets and patterns an advanced workspace lists as views, found
 * by the server from the same rows and place counts. Each `count` is the
 * length of its list, and every key list is sorted.
 */
export const queryTrackingViewsSchema = z.object({
  /** Locations no row has as its Subject: `counts.propertyQueries` is 0. */
  noPropertyQueries: z.object({
    count: countSchema,
    targetKeys: z.array(measurementV2StableKeySchema),
  }).strict(),
  /** Markets whose `counts.marketQueries` is under `floor`, a market with none included. */
  thinMarkets: z.object({
    count: countSchema,
    floor: z.number().int().positive(),
    marketKeys: z.array(measurementV2StableKeySchema),
  }).strict(),
  /** `count` is the number of patterns, sorted by `templateId`. */
  patternGaps: z.object({
    count: countSchema,
    /**
     * Patterns the rule could read: the saved ones whose one variable is a
     * market name, and any a market row froze that was deleted since. Zero
     * means nothing was compared, not that no gap was found. `count` never
     * exceeds it. Optional so a client tolerates a server that predates it.
     */
    compared: countSchema.optional(),
    patterns: z.array(queryTrackingPatternGapSchema),
  }).strict(),
}).strict()
export type QueryTrackingViews = z.output<typeof queryTrackingViewsSchema>

export const queryTrackingWorkspaceResponseSchema = z.object({
  mode: queryTrackingModeSchema,
  workspaceVersion: queryTrackingWorkspaceVersionSchema,
  active: z.object({
    revision: z.number().int().positive(),
    compiledChecksum: sha256HexSchema,
  }).strict().nullable(),
  defaultContexts: z.array(measurementV2ExecutionContextSchema),
  targets: z.array(queryTrackingTargetSchema),
  groups: z.array(queryTrackingGroupSchema),
  markets: z.array(queryTrackingMarketSchema),
  /**
   * Server-built scope choices for this workspace's Groups, markets, and
   * Properties. Optional so a client tolerates a server that predates it.
   */
  scopeOptions: z.array(visibilityReportScopeOptionSchema).optional(),
  tracked: z.array(queryTrackingTrackedRowSchema),
  savedSources: z.object({
    research: z.array(queryTrackingResearchCandidateSchema),
    discovery: z.array(queryTrackingDiscoveryCandidateSchema),
  }).strict(),
  /** Optional so a client tolerates a server that predates it. This server always sets it. */
  summary: queryTrackingSummarySchema.optional(),
  /** Advanced portfolios only, with `next` equal to `current`. Optional like `summary`. */
  limits: queryTrackingLimitsSchema.optional(),
  /** Advanced portfolios only. Optional like `summary`. */
  views: queryTrackingViewsSchema.optional(),
}).strict()
export type QueryTrackingWorkspaceResponse = z.output<typeof queryTrackingWorkspaceResponseSchema>

export const queryTrackingChangeRowSchema = z.object({
  queryId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  assignmentCount: z.number().int().nonnegative(),
}).strict()
export type QueryTrackingChangeRow = z.output<typeof queryTrackingChangeRowSchema>

export const queryTrackingDiffSchema = z.object({
  added: z.array(queryTrackingChangeRowSchema),
  removed: z.array(queryTrackingChangeRowSchema),
  reused: z.array(queryTrackingChangeRowSchema),
  unchanged: z.array(queryTrackingChangeRowSchema),
  noOp: z.boolean(),
}).strict()
export type QueryTrackingDiff = z.output<typeof queryTrackingDiffSchema>

/** Where one query is tracked: its Properties and the markets that report it. */
export const queryTrackingPlacementSchema = z.object({
  targetKeys: z.array(measurementV2StableKeySchema),
  marketKeys: z.array(measurementV2StableKeySchema),
}).strict()
export type QueryTrackingPlacement = z.output<typeof queryTrackingPlacementSchema>

/** One row per query in diff.added, diff.reused or diff.removed; none when diff.noOp is true. */
export const queryTrackingQueryChangeSchema = z.object({
  queryId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  change: z.enum(['added', 'reused', 'removed']),
  /** Placement in the active plan. */
  before: queryTrackingPlacementSchema,
  /** Placement in the reviewed candidate; a scoped removal keeps what remains. */
  after: queryTrackingPlacementSchema,
  /**
   * False when the change leaves this query exactly as the active plan has
   * it: the same wording, the same pairings (location identity, search
   * location and engines, type and its source) and the same market for each.
   * True for every added and removed row. Optional so a client tolerates a
   * server that predates it.
   */
  altered: z.boolean().optional(),
  /**
   * On the query a wording edit lands on: the id of the query that was
   * reworded, which the same review lists as removed. Absent on every other row.
   */
  rewordedFrom: queryTrackingIdSchema.optional(),
}).strict()
export type QueryTrackingQueryChange = z.output<typeof queryTrackingQueryChangeSchema>

/**
 * One added or reused query whose Type the reviewed change would set against
 * its Subject (`QUERY_CLASS_BY_FOCUS`), or a market query whose wording reads
 * as Branded. A report: nothing is refused for it.
 */
export const queryTrackingTypeMismatchSchema = z.object({
  queryId: queryTrackingIdSchema,
  queryText: queryTrackingTextSchema,
  /** The query's Subject in the reviewed candidate: a market or a location. */
  focus: queryTrackingFocusSchema,
  /** The Type that Subject takes. */
  expectedQueryClass: queryClassSchema,
  /** The row's Type in the reviewed candidate, as the tracked row reports it. */
  queryClasses: z.array(queryClassSchema),
  /**
   * True for a market query whose wording the server classifier reads as
   * Branded for one of its locations: it names the company or that location.
   */
  brandedWording: z.boolean(),
}).strict()
export type QueryTrackingTypeMismatch = z.output<typeof queryTrackingTypeMismatchSchema>

/**
 * One market whose locations change in the reviewed candidate. A market keeps
 * no member list: its locations are the ones its usage edges name, so a
 * removal can drop one. An emptied market stays in the plan and takes no
 * later addition.
 */
export const queryTrackingMarketChangeSchema = z.object({
  marketKey: measurementV2StableKeySchema,
  /** The market's locations in the active plan. */
  before: z.object({ targetKeys: z.array(measurementV2StableKeySchema) }).strict(),
  /** Its locations in the reviewed candidate. */
  after: z.object({ targetKeys: z.array(measurementV2StableKeySchema) }).strict(),
  /** In `before` and not in `after`. */
  removedTargetKeys: z.array(measurementV2StableKeySchema),
  /** True when `after` has no location left. */
  emptied: z.boolean(),
}).strict()
export type QueryTrackingMarketChange = z.output<typeof queryTrackingMarketChangeSchema>

/**
 * One market whose own-query count changes in the reviewed candidate: the rows
 * whose Subject is the market, the workspace read's `counts.marketQueries`.
 * Its locations may all stay (see `marketChanges` for those that leave).
 */
export const queryTrackingMarketQueryChangeSchema = z.object({
  marketKey: measurementV2StableKeySchema,
  /** The count in the active plan. */
  before: z.object({ marketQueries: countSchema }).strict(),
  /** The count in the reviewed candidate. */
  after: z.object({ marketQueries: countSchema }).strict(),
}).strict()
export type QueryTrackingMarketQueryChange = z.output<typeof queryTrackingMarketQueryChangeSchema>

/** Provider work is a deduplicated execution-node count, not an assignment count. */
export const queryTrackingWorkloadSchema = z.object({
  existingNodes: z.number().int().nonnegative(),
  existingProviderCalls: z.number().int().nonnegative(),
  nextSweepNodes: z.number().int().nonnegative(),
  nextSweepProviderCalls: z.number().int().nonnegative(),
  addedNodes: z.number().int().nonnegative(),
  addedProviderCalls: z.number().int().nonnegative(),
  removedNodes: z.number().int().nonnegative(),
  removedProviderCalls: z.number().int().nonnegative(),
}).strict()
export type QueryTrackingWorkload = z.output<typeof queryTrackingWorkloadSchema>

export const queryTrackingPreviewResponseSchema = z.object({
  mode: queryTrackingModeSchema,
  workspaceVersion: queryTrackingWorkspaceVersionSchema,
  previewToken: queryTrackingPreviewTokenSchema,
  /** Server time when this exact preview was constructed. Echo in commit. */
  reviewedAt: queryTrackingReviewedAtSchema,
  active: z.object({
    revision: z.number().int().positive(),
    compiledChecksum: sha256HexSchema,
  }).strict().nullable(),
  tracked: z.array(queryTrackingTrackedRowSchema),
  diff: queryTrackingDiffSchema,
  /**
   * Per-query placement before and after, empty for a no-op. Optional so a
   * client tolerates a server that predates it.
   */
  changes: z.array(queryTrackingQueryChangeSchema).optional(),
  /**
   * Advanced portfolios only: one row per market whose locations change, empty
   * when none does. Optional so a client tolerates a server that predates it.
   */
  marketChanges: z.array(queryTrackingMarketChangeSchema).optional(),
  /**
   * Advanced portfolios only: one row per market whose own-query count
   * changes, sorted by key, empty when none does. Optional like `marketChanges`.
   */
  marketQueryChanges: z.array(queryTrackingMarketQueryChangeSchema).optional(),
  /**
   * Advanced portfolios only: the added and reused queries this change would
   * leave with a Type their Subject does not take, empty when none. Optional
   * like `marketChanges`.
   */
  typeMismatches: z.array(queryTrackingTypeMismatchSchema).optional(),
  workload: queryTrackingWorkloadSchema,
  /**
   * Advanced portfolios only. Optional so a client tolerates a server that
   * predates it.
   */
  limits: queryTrackingLimitsSchema.optional(),
}).strict()
export type QueryTrackingPreviewResponse = z.output<typeof queryTrackingPreviewResponseSchema>

export const queryTrackingCommitResponseSchema = z.object({
  committed: z.boolean(),
  mode: queryTrackingModeSchema,
  workspaceVersion: queryTrackingWorkspaceVersionSchema,
  reviewedAt: queryTrackingReviewedAtSchema,
  active: z.object({
    revision: z.number().int().positive(),
    compiledChecksum: sha256HexSchema,
  }).strict().nullable(),
  diff: queryTrackingDiffSchema,
  workload: queryTrackingWorkloadSchema,
}).strict()
export type QueryTrackingCommitResponse = z.output<typeof queryTrackingCommitResponseSchema>
