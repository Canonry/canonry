import type { FastifyInstance } from 'fastify'
import {
  AppError,
  bucketDuration,
  classifyOutcomeError,
  OutcomeReasonCodes,
  OutcomeStatuses,
  type FeatureCompletedProperties,
  type FeatureName,
  type FeatureOperation,
  type OutcomeCountKey,
  type OutcomeReasonCode,
  type OutcomeStatus,
  type OutcomeTrigger,
} from '@ainyc/canonry-contracts'
import type { OutcomeAttribution } from './outcome-telemetry.js'

/** What an operation ended as. The helpers add the feature, operation, trigger and duration. */
export type FeatureOutcome = Omit<FeatureCompletedProperties, 'feature' | 'operation' | 'trigger' | 'surface' | 'agent'>

export interface FeatureOutcomeTarget<F extends FeatureName = FeatureName> {
  feature: F
  operation: FeatureOperation<F>
  /** Only when the request cannot say (a retry, a scheduled pass); otherwise the host derives it from who asked. */
  trigger?: OutcomeTrigger
  /** Who asked, captured with `currentOutcomeAttribution()` during the request, for work that reports after it. */
  attribution?: OutcomeAttribution
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
        ...(target.trigger ? { trigger: target.trigger } : {}),
        ...outcome,
      },
      ...(target.attribution ? { attribution: target.attribution } : {}),
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

/** One operation's result as reported: a status, a reason and counts, never names, ids or messages. */
export interface RouteOutcome {
  status: OutcomeStatus
  reasonCode?: OutcomeReasonCode
  errorName?: string
  counts?: Partial<Record<OutcomeCountKey, number>>
}

export interface RouteOutcomeReporter {
  /** Send the outcome. Only the first call sends. */
  report(outcome: RouteOutcome): void
  /** Report a refusal with a known reason and return the error to throw. */
  refuse<E>(reasonCode: OutcomeReasonCode, error: E): E
  /** Run a guard; when it throws, report the failure with `reasonCode` and rethrow. */
  guard<T>(reasonCode: OutcomeReasonCode, check: () => T): T
}

/** For a route whose outcome is decided at several points: reports one `feature.completed`, at most once. */
export function startRouteOutcome<F extends FeatureName>(
  app: FastifyInstance,
  feature: F,
  operation: FeatureOperation<F>,
  options: { trigger?: OutcomeTrigger } = {},
): RouteOutcomeReporter {
  const startedAt = Date.now()
  let sent = false
  const report = (outcome: RouteOutcome): void => {
    if (sent) return
    sent = true
    const counts = Object.entries(outcome.counts ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    reportFeatureOutcome(app, { feature, operation, ...options }, {
      status: outcome.status,
      ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
      ...(outcome.errorName ? { errorName: outcome.errorName } : {}),
      durationBucket: bucketDuration(Date.now() - startedAt),
      ...(counts.length > 0 ? { counts: Object.fromEntries(counts) } : {}),
    })
  }
  return {
    report,
    refuse(reasonCode, error) {
      report({ status: OutcomeStatuses.failed, reasonCode })
      return error
    },
    guard(reasonCode, check) {
      try {
        return check()
      } catch (err) {
        report({ status: OutcomeStatuses.failed, ...classifyOutcomeError(err), reasonCode })
        throw err
      }
    },
  }
}

/** A failure as an outcome reason. A provider error carries the upstream status in its details. */
export function upstreamFailure(err: unknown): { reasonCode: OutcomeReasonCode; errorName?: string } {
  const classified = classifyOutcomeError(err)
  const upstreamStatus = err instanceof AppError ? err.details?.upstreamStatus : undefined
  return typeof upstreamStatus === 'number'
    ? { ...classified, reasonCode: classifyOutcomeError({ status: upstreamStatus }).reasonCode }
    : classified
}

/** A failed OAuth refresh or service-account token exchange is a rejected credential, unless throttled or unanswered. */
export function credentialFailure(err: unknown): { reasonCode: OutcomeReasonCode; errorName?: string } {
  const classified = classifyOutcomeError(err)
  const transient: OutcomeReasonCode[] = [OutcomeReasonCodes.RATE_LIMITED, OutcomeReasonCodes.TIMEOUT, OutcomeReasonCodes.NETWORK]
  return transient.includes(classified.reasonCode) ? classified : { ...classified, reasonCode: OutcomeReasonCodes.INVALID_CREDENTIALS }
}
