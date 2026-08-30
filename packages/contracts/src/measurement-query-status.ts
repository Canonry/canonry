import { z } from 'zod'

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
}).strict()
export type MeasurementQueryStatusRow = z.output<typeof measurementQueryStatusRowSchema>

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
}).strict()
export type MeasurementQueryStatusesResponse = z.output<typeof measurementQueryStatusesResponseSchema>
