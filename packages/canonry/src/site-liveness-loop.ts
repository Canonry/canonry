import { projects } from '@ainyc/canonry-db'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  OutcomeReasonCodes,
  OutcomeStatuses,
  OutcomeSurfaces,
  OutcomeTriggers,
  type FeatureCompletedProperties,
} from '@ainyc/canonry-contracts'
import { createLogger } from './logger.js'
import { createOutcomeSampler, outcomeFailure, startOutcomeTimer, trackFeatureCompleted } from './outcome-telemetry.js'

const log = createLogger('SiteLiveness')

/**
 * Probe every project's homepage on a fixed interval, in this process.
 *
 * Deliberately NOT a schedule row. A row carries a `kind`, and an older build
 * that does not know the kind registers the row anyway and falls through to its
 * default answer-visibility flow: a rollback would have turned every project's
 * liveness row into a paid provider sweep every ten minutes, with no CLI able to
 * disable it because the old build also rejects the kind. An interval owned by
 * the running process disappears the moment that process does.
 *
 * It also stays off the HTTP API: the checks run in-process, so a pass writes no
 * request logs. At a few minutes' cadence across many projects, request logging
 * alone would evict a night of real diagnostics from the operational log buffer.
 */
export const SITE_LIVENESS_INTERVAL_MS = 10 * 60_000

export interface SiteLivenessCheckResult {
  id: string
  status: string
  code: string
  summary: string
  remediation?: string | null
}

export interface SiteLivenessProject {
  id: string
  name: string
  canonicalDomain: string
  displayName: string
}

export interface SiteLivenessDeps {
  db: DatabaseClient
  /** Runs the reachability check for one project. Null when it produced no result. */
  probe: (project: SiteLivenessProject) => Promise<SiteLivenessCheckResult | null>
  notify: (
    projectId: string,
    result: { check: SiteLivenessCheckResult; checkedAt: string },
  ) => Promise<'health.degraded' | 'health.recovered' | null>
  now?: () => string
}

export interface SiteLivenessPassResult {
  checked: number
  events: number
  /** Projects whose probe or notification threw, and the first such error. */
  failed: number
  firstFailure?: unknown
}

/** One pass over every project. One project's failure never stops the others. */
export async function runSiteLivenessPass(deps: SiteLivenessDeps): Promise<SiteLivenessPassResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const rows = deps.db
    .select({ id: projects.id, name: projects.name, canonicalDomain: projects.canonicalDomain, displayName: projects.displayName })
    .from(projects)
    .all()
  let checked = 0
  let events = 0
  let failed = 0
  let firstFailure: unknown
  for (const project of rows) {
    try {
      const check = await deps.probe(project)
      if (!check) continue
      checked += 1
      const event = await deps.notify(project.id, { check, checkedAt: now() })
      if (event) {
        events += 1
        // Only transitions are logged. A quiet pass per project per interval
        // would be the loudest thing in the log and would push out real history.
        log.info('site-liveness.notified', { projectName: project.name, event, code: check.code })
      }
    } catch (err: unknown) {
      log.warn('site-liveness.project-failed', { projectName: project.name, err: String(err) })
      if (failed === 0) firstFailure = err
      failed += 1
    }
  }
  return { checked, events, failed, ...(failed > 0 ? { firstFailure } : {}) }
}

type LivenessOutcome = Pick<FeatureCompletedProperties, 'status' | 'reasonCode' | 'errorName' | 'counts' | 'durationBucket'>

/** Nothing checked and nothing failed: no project, or no probe produced a check. */
function livenessOutcome(result: SiteLivenessPassResult): LivenessOutcome {
  const counts = { pages: result.checked, failures: result.failed }
  if (result.failed > 0) {
    return { status: result.checked > 0 ? OutcomeStatuses.partial : OutcomeStatuses.failed, ...outcomeFailure(result.firstFailure), counts }
  }
  if (result.checked === 0) return { status: OutcomeStatuses.skipped, reasonCode: OutcomeReasonCodes.NO_DATA }
  return { status: OutcomeStatuses.succeeded, counts }
}

/**
 * Start the loop. The first pass happens one interval in, not at boot: a pass
 * during startup would observe a network that is not up yet.
 */
export function startSiteLivenessLoop(deps: SiteLivenessDeps, intervalMs = SITE_LIVENESS_INTERVAL_MS): () => void {
  let running = false
  // A pass every ten minutes is mostly routine, so pass outcomes are sampled per status and reason.
  const sample = createOutcomeSampler({ burst: 2, refillMs: 60 * 60_000 })
  const report = (outcome: LivenessOutcome) => {
    const sampled = sample(`${outcome.status}:${outcome.reasonCode ?? ''}`)
    if (!sampled.send) return
    trackFeatureCompleted({
      feature: 'site_liveness',
      operation: 'check',
      trigger: OutcomeTriggers.scheduled,
      surface: OutcomeSurfaces.system,
      ...outcome,
      ...(sampled.droppedBefore ? { droppedBefore: sampled.droppedBefore } : {}),
    })
  }
  const timer = setInterval(() => {
    // A pass that overruns its interval must not race the next one: two passes
    // in flight could each see one failure and page the same outage twice.
    if (running) {
      log.warn('site-liveness.pass-still-running', { intervalMs })
      report({ status: OutcomeStatuses.skipped, reasonCode: OutcomeReasonCodes.OPERATION_IN_PROGRESS })
      return
    }
    running = true
    const elapsed = startOutcomeTimer()
    void runSiteLivenessPass(deps)
      .then(result => report({ ...livenessOutcome(result), durationBucket: elapsed() }))
      .catch((err: unknown) => {
        log.warn('site-liveness.pass-failed', { err: String(err) })
        report({ status: OutcomeStatuses.failed, ...outcomeFailure(err), durationBucket: elapsed() })
      })
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
