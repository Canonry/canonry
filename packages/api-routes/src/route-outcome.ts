import type { FastifyInstance } from 'fastify'
import {
  AppError,
  bucketDuration,
  classifyOutcomeError,
  isFetchTransportError,
  OutcomeReasonCodes,
  OutcomeStatuses,
  type FeatureName,
  type FeatureOperation,
  type OutcomeCountKey,
  type OutcomeReasonCode,
  type OutcomeStatus,
  type OutcomeTrigger,
} from '@ainyc/canonry-contracts'

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

/** Report one route operation as `feature.completed`, at most once. The host adds surface, agent and, if absent, trigger. */
export function startRouteOutcome<F extends FeatureName>(
  app: FastifyInstance,
  feature: F,
  operation: FeatureOperation<F>,
  options: { trigger?: OutcomeTrigger } = {},
): RouteOutcomeReporter {
  const startedAt = Date.now()
  // A plugin mounted without `apiRoutes` (as some tests do) has no outcome sink.
  const emit = (app as Partial<Pick<FastifyInstance, 'emitOutcome'>>).emitOutcome
  let sent = false
  const report = (outcome: RouteOutcome): void => {
    if (sent || !emit) return
    sent = true
    const counts = Object.entries(outcome.counts ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    emit({
      event: 'feature.completed',
      properties: {
        feature,
        operation,
        status: outcome.status,
        ...(options.trigger ? { trigger: options.trigger } : {}),
        ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
        ...(outcome.errorName ? { errorName: outcome.errorName } : {}),
        durationBucket: bucketDuration(Date.now() - startedAt),
        ...(counts.length > 0 ? { counts: Object.fromEntries(counts) } : {}),
      },
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
  if (transient.includes(classified.reasonCode)) return classified
  // undici keeps the socket error code on `cause`, where the classifier does not look.
  if (isFetchTransportError(err)) return { ...classified, reasonCode: OutcomeReasonCodes.NETWORK }
  return { ...classified, reasonCode: OutcomeReasonCodes.INVALID_CREDENTIALS }
}
