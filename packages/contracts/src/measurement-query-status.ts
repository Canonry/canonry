import { z } from 'zod'
import { QUERY_CLASSES, queryClassSchema } from './query-class.js'

const classCountSchema = z.object({
  queryClass: queryClassSchema,
  assignedTargetCount: z.number().int().positive(),
}).strict()

function expectedClassState(classes: readonly z.output<typeof queryClassSchema>[]): 'branded' | 'non-brand' | 'mixed' {
  if (classes.length === 2) return 'mixed'
  return classes[0]!
}

function hasCanonicalClassCounts(
  counts: readonly z.output<typeof classCountSchema>[],
  expectedTotal: number,
): boolean {
  const classes = counts.map(count => count.queryClass)
  const expectedClasses = QUERY_CLASSES.filter(queryClass => classes.includes(queryClass))
  return counts.reduce((total, count) => total + count.assignedTargetCount, 0) === expectedTotal
    && classes.length === expectedClasses.length
    && classes.every((queryClass, index) => queryClass === expectedClasses[index])
}

export const measurementQueryAssignmentScopeModeSchema = z.enum([
  'simple',
  'legacy',
  'advanced_unassigned',
  'advanced_assigned',
])
export type MeasurementQueryAssignmentScopeMode = z.output<typeof measurementQueryAssignmentScopeModeSchema>

export const measurementQueryAssignmentClassStateSchema = z.enum([
  'unavailable',
  'none',
  'branded',
  'non-brand',
  'mixed',
])
export type MeasurementQueryAssignmentClassState = z.output<typeof measurementQueryAssignmentClassStateSchema>

/**
 * Groups are reporting/bulk-selection lenses, not assignment owners. Each
 * entry is the server-derived overlap between the group's concrete members and
 * this query's published Target assignments; it is intentionally non-additive
 * across overlapping groups.
 */
export const measurementQueryGroupCoverageSchema = z.object({
  groupKey: z.string().trim().min(1),
  label: z.string().trim().min(1),
  memberCount: z.number().int().positive(),
  assignedMemberCount: z.number().int().positive(),
  coverage: z.enum(['partial', 'complete']),
  classCounts: z.array(classCountSchema).min(1),
}).strict().superRefine((coverage, ctx) => {
  if (coverage.assignedMemberCount > coverage.memberCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assignedMemberCount'], message: 'Cannot exceed group member count' })
  }
  const expectedCoverage = coverage.assignedMemberCount === coverage.memberCount ? 'complete' : 'partial'
  if (coverage.coverage !== expectedCoverage) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage'], message: 'Must match assigned member count' })
  }
  if (!hasCanonicalClassCounts(coverage.classCounts, coverage.assignedMemberCount)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classCounts'], message: 'Must be canonical and sum to assigned member count' })
  }
})
export type MeasurementQueryGroupCoverage = z.output<typeof measurementQueryGroupCoverageSchema>

const unavailableScopeFields = {
  assignedTargetCount: z.null(),
  classState: z.literal('unavailable'),
  queryClasses: z.array(queryClassSchema).length(0),
  classCounts: z.array(classCountSchema).length(0),
  groupCoverage: z.array(measurementQueryGroupCoverageSchema).length(0),
}

const simpleAssignmentScopeSchema = z.object({
  mode: z.literal('simple'),
  activePlanQueryText: z.null(),
  queryTextMatchesPlan: z.null(),
  ...unavailableScopeFields,
}).strict()

const legacyAssignmentScopeSchema = z.object({
  mode: z.literal('legacy'),
  activePlanQueryText: z.string().min(1).nullable(),
  queryTextMatchesPlan: z.boolean().nullable(),
  ...unavailableScopeFields,
}).strict().superRefine((scope, ctx) => {
  if ((scope.activePlanQueryText === null) !== (scope.queryTextMatchesPlan === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['queryTextMatchesPlan'], message: 'Requires an active plan query text' })
  }
})

const advancedUnassignedScopeSchema = z.object({
  mode: z.literal('advanced_unassigned'),
  activePlanQueryText: z.null(),
  queryTextMatchesPlan: z.null(),
  assignedTargetCount: z.literal(0),
  classState: z.literal('none'),
  queryClasses: z.array(queryClassSchema).length(0),
  classCounts: z.array(classCountSchema).length(0),
  groupCoverage: z.array(measurementQueryGroupCoverageSchema).length(0),
}).strict()

const advancedAssignedScopeSchema = z.object({
  mode: z.literal('advanced_assigned'),
  activePlanQueryText: z.string().min(1),
  queryTextMatchesPlan: z.boolean().nullable(),
  assignedTargetCount: z.number().int().positive(),
  classState: z.enum(['branded', 'non-brand', 'mixed']),
  queryClasses: z.array(queryClassSchema).min(1).max(QUERY_CLASSES.length),
  classCounts: z.array(classCountSchema).min(1).max(QUERY_CLASSES.length),
  groupCoverage: z.array(measurementQueryGroupCoverageSchema),
}).strict().superRefine((scope, ctx) => {
  if (!hasCanonicalClassCounts(scope.classCounts, scope.assignedTargetCount)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classCounts'], message: 'Must be canonical and sum to assigned target count' })
  }
  const classes = scope.classCounts.map(count => count.queryClass)
  if (scope.queryClasses.length !== classes.length || scope.queryClasses.some((queryClass, index) => queryClass !== classes[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['queryClasses'], message: 'Must match class counts' })
  }
  if (scope.classState !== expectedClassState(classes)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classState'], message: 'Must match query classes' })
  }
})

/**
 * Canonical active-plan scope for one query. It remains optional on the row so
 * older servers and intentionally minimal consumers can fail closed rather
 * than inventing property scope from the query text.
 */
export const measurementQueryAssignmentScopeSchema = z.discriminatedUnion('mode', [
  simpleAssignmentScopeSchema,
  legacyAssignmentScopeSchema,
  advancedUnassignedScopeSchema,
  advancedAssignedScopeSchema,
])
export type MeasurementQueryAssignmentScope = z.output<typeof measurementQueryAssignmentScopeSchema>

export const measurementQueryCatalogStateSchema = z.enum(['current', 'missing'])
export type MeasurementQueryCatalogState = z.output<typeof measurementQueryCatalogStateSchema>

/**
 * Server-derived readiness for one currently tracked query. A browser must not
 * reconstruct this from a query list and historical runs: plan membership and
 * whole-run eligibility are both immutable-plan concerns.
 */
export const measurementQueryStatusSchema = z.enum([
  'not_in_plan',
  'awaiting_first_sweep',
  'partial',
  'measured',
])
export type MeasurementQueryStatus = z.output<typeof measurementQueryStatusSchema>

/** Only active persisted plan modes participate in the status read. */
export const measurementQueryStatusSetupModeSchema = z.enum(['simple', 'active-v1', 'active-v2'])
export type MeasurementQueryStatusSetupMode = z.output<typeof measurementQueryStatusSetupModeSchema>

export const measurementQueryStatusRunSchema = z.object({
  id: z.string().trim().min(1),
  status: z.enum(['completed', 'partial']),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
}).strict()
export type MeasurementQueryStatusRun = z.output<typeof measurementQueryStatusRunSchema>

export const measurementQueryStatusRowSchema = z.object({
  queryId: z.string().trim().min(1),
  status: measurementQueryStatusSchema,
  /** Additive catalog identity. Missing rows are returned only in activePlanOrphans. */
  catalogState: measurementQueryCatalogStateSchema.optional(),
  currentQueryText: z.string().min(1).nullable().optional(),
  assignmentScope: measurementQueryAssignmentScopeSchema.optional(),
}).strict()
export type MeasurementQueryStatusRow = z.output<typeof measurementQueryStatusRowSchema>

/** A frozen active-plan query whose current catalog row was deleted. */
export const measurementQueryStatusOrphanSchema = measurementQueryStatusRowSchema.extend({
  catalogState: z.literal('missing'),
  currentQueryText: z.null(),
  assignmentScope: measurementQueryAssignmentScopeSchema,
}).strict()
export type MeasurementQueryStatusOrphan = z.output<typeof measurementQueryStatusOrphanSchema>

/**
 * One stable row for every currently tracked query, ordered by query text then
 * id. `latestOfficialFullRun` stays null until the active v2 revision has an
 * eligible non-probe, unscoped terminal sweep.
 */
export const measurementQueryStatusesResponseSchema = z.object({
  setupMode: measurementQueryStatusSetupModeSchema,
  activeRevision: z.number().int().positive().nullable(),
  latestOfficialFullRun: measurementQueryStatusRunSchema.nullable(),
  queries: z.array(measurementQueryStatusRowSchema),
  /** Frozen active-plan queries absent from the current catalog. Never merge into `queries`. */
  activePlanOrphans: z.array(measurementQueryStatusOrphanSchema).optional().default([]),
}).strict()
export type MeasurementQueryStatusesResponse = z.output<typeof measurementQueryStatusesResponseSchema>
