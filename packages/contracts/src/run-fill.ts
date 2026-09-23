import { z } from 'zod'
import { AppError } from './errors.js'
import { providerNameSchema } from './provider.js'
import { runStatusSchema } from './run.js'

/**
 * Completing a partial run in place.
 *
 * A fill executes only the expected slots a partial plan run never recorded,
 * under the SAME run id. The run keeps its one identity, frozen manifest and
 * denominator, and every reader already selects one run and reads its rows,
 * so a filled answer counts with no reader change and the run never appears
 * twice.
 */

/** How long after a run starts its missing slots may still be filled. */
export const RUN_FILL_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Consecutive failures after which a fill stops dispatching to a provider.
 * A provider still over its cap would otherwise be paid for, or fail, on
 * every remaining slot.
 */
export const RUN_FILL_PROVIDER_BREAKER = 3

export const runFillStatusSchema = z.enum(['queued', 'running', 'completed', 'partial', 'failed'])
export type RunFillStatus = z.infer<typeof runFillStatusSchema>
export const RunFillStatuses = runFillStatusSchema.enum

/**
 * Why a run cannot be filled right now. Every code is permanent for that run
 * except `quota_insufficient`, which clears when the provider's daily usage
 * resets at 00:00 UTC or its limit is raised.
 */
export const runFillRefusalCodeSchema = z.enum([
  'not_answer_visibility',
  'not_plan_run',
  'scoped_or_probe',
  'status_not_partial',
  'plan_revision_changed',
  'manifest_unreadable',
  'model_not_frozen',
  'provider_not_in_plan',
  'provider_nothing_missing',
  'provider_not_configured',
  'too_old',
  'superseded',
  'quota_insufficient',
])
export type RunFillRefusalCode = z.infer<typeof runFillRefusalCodeSchema>
export const RunFillRefusalCodes = runFillRefusalCodeSchema.enum

export const runFillRequestSchema = z.object({
  /** Fill only these providers' missing slots. Omit for every provider with gaps. */
  providers: z.array(providerNameSchema).min(1).optional(),
  /** Evaluate every rule and report what would run, without queueing anything. */
  dryRun: z.boolean().optional(),
}).strict()
export type RunFillRequest = z.infer<typeof runFillRequestSchema>

export const runFillDtoSchema = z.object({
  id: z.string(),
  runId: z.string(),
  projectId: z.string(),
  status: runFillStatusSchema,
  /** Providers this fill was asked to complete. */
  providers: z.array(z.string()),
  /** Missing slots this fill set out to record. */
  expected: z.number().int().nonnegative(),
  /** Slots it actually recorded. */
  filled: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type RunFillDto = z.infer<typeof runFillDtoSchema>

export const runCompletenessDtoSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  /** Whether the run measured a published plan. A planless run has no slots to fill. */
  planned: z.boolean(),
  /**
   * False when the run's manifest cannot be read. The counts are then 0 and
   * mean "unknown", not "nothing missing".
   */
  readable: z.boolean(),
  expected: z.number().int().nonnegative(),
  executed: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  /** Missing slots per provider. Absent providers have none. */
  missingByProvider: z.record(z.string(), z.number().int().nonnegative()),
  /** Whether `POST /runs/{id}/fill` would queue a fill right now. */
  fillable: z.boolean(),
  /** Why it would not, when that reason is permanent. */
  refusal: z.object({ code: runFillRefusalCodeSchema, message: z.string() }).nullable(),
  latestFill: runFillDtoSchema.nullable(),
})
export type RunCompletenessDto = z.infer<typeof runCompletenessDtoSchema>

export const runFillOutcomeSchema = z.enum(['queued', 'already-complete', 'dry-run'])
export type RunFillOutcome = z.infer<typeof runFillOutcomeSchema>

export const runFillResponseDtoSchema = z.object({
  outcome: runFillOutcomeSchema,
  completeness: runCompletenessDtoSchema,
  /** The queued fill. Null for a dry run or an already-complete run. */
  fill: runFillDtoSchema.nullable(),
})
export type RunFillResponseDto = z.infer<typeof runFillResponseDtoSchema>

/**
 * Why the post-run pipeline is running. A fill completes a run the sweep
 * already reported as partial, so its receivers must not get a second
 * `run.completed` for the same run.
 */
export type RunCompletionOrigin = 'sweep' | 'fill'

/** The run cannot be filled now; `details.refusal` names the rule. */
export function runFillRefused(code: RunFillRefusalCode, message: string, details?: Record<string, unknown>): AppError {
  return new AppError('RUN_FILL_REFUSED', message, 409, { refusal: code, ...details })
}

/** Another fill for this project is still queued or running. */
export function runFillInProgress(runId: string, fillId: string): AppError {
  return new AppError(
    'RUN_FILL_IN_PROGRESS',
    `A fill (${fillId}) is already queued or running for this project. Wait for it to finish, then fill again.`,
    409,
    { runId, fillId },
  )
}
