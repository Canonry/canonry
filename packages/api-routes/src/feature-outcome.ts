import type { FastifyInstance } from 'fastify'
import {
  bucketDuration,
  classifyOutcomeError,
  OutcomeStatuses,
  OutcomeTriggers,
  type FeatureCompletedProperties,
  type FeatureName,
  type FeatureOperation,
  type OutcomeReasonCode,
  type OutcomeSurface,
  type OutcomeTrigger,
} from '@ainyc/canonry-contracts'

/** What an operation ended as. The helpers add the feature, operation, trigger and duration. */
export type FeatureOutcome = Omit<FeatureCompletedProperties, 'feature' | 'operation' | 'trigger' | 'surface' | 'agent'>

export interface FeatureOutcomeTarget<F extends FeatureName = FeatureName> {
  feature: F
  operation: FeatureOperation<F>
  /** Route code runs because someone asked, so this defaults to `manual`. */
  trigger?: OutcomeTrigger
  /** Only for work that ends after its request; otherwise the host reads the surface from the request. */
  surface?: OutcomeSurface
}

/** Report one `feature.completed` from route code. Never throws. */
export function reportFeatureOutcome<F extends FeatureName>(
  app: FastifyInstance,
  target: FeatureOutcomeTarget<F>,
  outcome: FeatureOutcome,
): void {
  try {
    app.emitOutcome({
      event: 'feature.completed',
      properties: {
        feature: target.feature,
        operation: target.operation,
        trigger: target.trigger ?? OutcomeTriggers.manual,
        ...(target.surface ? { surface: target.surface } : {}),
        ...outcome,
      },
    })
  } catch {
    // Outcome telemetry is best effort and never changes a response.
  }
}

/** A failed outcome from a caught error: a reason code and the error class name, never the message. */
export function failedOutcome(err: unknown, reasonCode?: OutcomeReasonCode): FeatureOutcome {
  return { status: OutcomeStatuses.failed, ...classifyOutcomeError(err), ...(reasonCode ? { reasonCode } : {}) }
}

/**
 * Run one route operation and report exactly one outcome for it. `settle`
 * records a result other than plain success (counts, a skip, a refusal the
 * route is about to throw). Without it, returning reports `succeeded` and
 * throwing reports `failed`, classified by `failureReason` first and then by
 * the error's code and status. `settle(null)` reports nothing, for an exit
 * whose outcome is reported elsewhere (a replayed request, or work handed to a
 * background task that reports when it finishes).
 */
export async function withFeatureOutcome<F extends FeatureName, T>(
  app: FastifyInstance,
  target: FeatureOutcomeTarget<F>,
  run: (settle: (outcome: FeatureOutcome | null) => void) => Promise<T>,
  failureReason?: (err: unknown) => OutcomeReasonCode | undefined,
): Promise<T> {
  const startedAt = Date.now()
  let settled: FeatureOutcome | null | undefined
  const report = (outcome: () => FeatureOutcome | null) => {
    try {
      const resolved = outcome()
      if (resolved) reportFeatureOutcome(app, target, { ...resolved, durationBucket: bucketDuration(Date.now() - startedAt) })
    } catch {
      // Classifying the outcome must not replace the route's own result or error.
    }
  }
  let result: T
  try {
    result = await run(outcome => { settled = outcome })
  } catch (err) {
    report(() => {
      if (settled === null) return null
      // A success recorded before a later throw never reached the caller.
      if (settled && settled.status !== OutcomeStatuses.succeeded) return settled
      return failedOutcome(err, failureReason?.(err))
    })
    throw err
  }
  report(() => settled === undefined ? { status: OutcomeStatuses.succeeded } : settled)
  return result
}
