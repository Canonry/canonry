import { eq } from 'drizzle-orm'
import { credentialFailure } from '@ainyc/canonry-api-routes'
import { getRequestContext } from '@ainyc/canonry-api-routes/request-context'
import { runs, type DatabaseClient } from '@ainyc/canonry-db'
import { GoogleApiError, GoogleAuthError } from '@ainyc/canonry-integration-google'
import {
  OutcomeReasonCodes,
  OutcomeStatuses,
  OutcomeSurfaces,
  OutcomeTriggers,
  RunTriggers,
  type FeatureName,
  type FeatureOperation,
  type OutcomeCountKey,
  type OutcomeReasonCode,
  type OutcomeStatus,
  type OutcomeSurface,
  type OutcomeTrigger,
} from '@ainyc/canonry-contracts'
import { outcomeAttribution, outcomeFailure, outcomeTriggerFor, startOutcomeTimer, trackFeatureCompleted } from './outcome-telemetry.js'

/** Who started a run: the request that queued it, or the server itself. */
interface OutcomeOrigin {
  trigger?: OutcomeTrigger
  surface?: OutcomeSurface
  agent?: string
}

/** A run's result as reported: a status, a reason and counts, never names, ids or messages. */
export interface RunOutcome {
  status: OutcomeStatus
  reasonCode?: OutcomeReasonCode
  errorName?: string
  counts?: Partial<Record<OutcomeCountKey, number>>
}

/** Who asked for the current work, read from the active HTTP request. Undefined outside one. */
function requestOutcomeOrigin(): OutcomeOrigin | undefined {
  const context = getRequestContext()
  if (!context) return undefined
  const attribution = { userAgent: context.userAgent, surfaceLabel: context.usageSurface, agentLabel: context.usageAgent }
  return { trigger: outcomeTriggerFor(attribution), ...outcomeAttribution(attribution) }
}

function storedRunTrigger(db: DatabaseClient, runId: string): string | undefined {
  const row = db.select({ trigger: runs.trigger }).from(runs).where(eq(runs.id, runId)).get()
  return typeof row?.trigger === 'string' ? row.trigger : undefined
}

/** A run the server queued itself (a schedule, a chained refresh) is scheduled; any other run is what its request said. */
function runOrigin(storedTrigger: string | undefined, requested: OutcomeOrigin | undefined): OutcomeOrigin {
  if (storedTrigger === RunTriggers.scheduled) return { trigger: OutcomeTriggers.scheduled, surface: OutcomeSurfaces.system }
  if (requested) return requested
  return storedTrigger === RunTriggers.manual ? { trigger: OutcomeTriggers.manual } : {}
}

function compactCounts(counts: RunOutcome['counts']): Record<string, number> | undefined {
  const entries = Object.entries(counts ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * Start reporting one run as `feature.completed`. Call it before the run's first await, while the
 * request that queued it is still active. The returned function never throws.
 */
export function startRunOutcome<F extends FeatureName>(
  db: DatabaseClient,
  runId: string,
  feature: F,
  operation: FeatureOperation<F>,
): (outcome: RunOutcome) => void {
  let requested: OutcomeOrigin | undefined
  try {
    requested = requestOutcomeOrigin()
  } catch {
    requested = undefined
  }
  const elapsed = startOutcomeTimer()
  return (outcome) => {
    try {
      trackFeatureCompleted({
        feature,
        operation,
        ...runOrigin(storedRunTrigger(db, runId), requested),
        status: outcome.status,
        reasonCode: outcome.reasonCode,
        errorName: outcome.errorName,
        durationBucket: elapsed(),
        counts: compactCounts(outcome.counts),
      })
    } catch {
      // Telemetry must never change a run's result.
    }
  }
}

/** Report a queued run that the server could not start. Call it from the callback that was asked to start it. */
export function reportUnstartedRun<F extends FeatureName>(
  db: DatabaseClient,
  runId: string,
  feature: F,
  operation: FeatureOperation<F>,
  reasonCode: OutcomeReasonCode,
): void {
  startRunOutcome(db, runId, feature, operation)({ status: OutcomeStatuses.failed, reasonCode })
}

const knownReasons = new WeakMap<object, OutcomeReasonCode>()

/** Attach the reason a precondition failed to the error it throws. The error itself is unchanged. */
export function withOutcomeReason<E extends object>(err: E, reasonCode: OutcomeReasonCode): E {
  knownReasons.set(err, reasonCode)
  return err
}

/** The failure half of a run outcome: a reason attached at the throw site wins over the classifier. */
export function runFailure(err: unknown, fallback?: OutcomeReasonCode): { reasonCode: OutcomeReasonCode; errorName?: string } {
  const known = typeof err === 'object' && err !== null ? knownReasons.get(err) : undefined
  return outcomeFailure(err, known ?? fallback)
}

/** A Google run failure: a failed token refresh is a revoked grant, and a 404 from Search Console a property that is gone. */
export function googleRunFailure(err: unknown): { reasonCode: OutcomeReasonCode; errorName?: string } {
  if (err instanceof GoogleAuthError) return credentialFailure(err)
  return runFailure(err, err instanceof GoogleApiError && err.status === 404 ? OutcomeReasonCodes.PROPERTY_NOT_FOUND : undefined)
}
