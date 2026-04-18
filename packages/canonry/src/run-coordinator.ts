import type { Notifier } from './notifier.js'
import type { IntelligenceService } from './intelligence-service.js'
import type { AnalysisResult } from '@ainyc/canonry-intelligence'
import { createLogger } from './logger.js'

const log = createLogger('RunCoordinator')

/**
 * Notifies the built-in Aero agent that a run just completed.
 *
 * Implementation lives in `server.ts` and wires through `SessionRegistry`.
 * Invoked after intelligence + notifier have finished so the registry's
 * payload can cite the computed insight count. Returns Promise<void>;
 * failures MUST be handled internally (logged, never thrown) so one
 * subscriber can't starve the others.
 */
export type OnAeroEvent = (ctx: {
  runId: string
  projectId: string
  insightCount: number
  criticalOrHigh: number
}) => Promise<void>

/**
 * Post-run orchestrator that dispatches to multiple subscribers with
 * failure isolation. One subscriber failing must not starve the others.
 */
export class RunCoordinator {
  constructor(
    private notifier: Notifier,
    private intelligenceService: IntelligenceService,
    private onInsightsGenerated?: (runId: string, projectId: string, result: AnalysisResult) => Promise<void>,
    private onAeroEvent?: OnAeroEvent,
  ) {}

  async onRunCompleted(runId: string, projectId: string): Promise<void> {
    let insightCount = 0
    let criticalOrHigh = 0

    // 1. Intelligence — always runs, catches its own errors.
    //    Runs first so insights are persisted before webhooks fire.
    try {
      const result = this.intelligenceService.analyzeAndPersist(runId, projectId)
      if (result) {
        insightCount = result.insights.length
        criticalOrHigh = result.insights.filter(
          i => i.severity === 'critical' || i.severity === 'high',
        ).length

        if (this.onInsightsGenerated && criticalOrHigh > 0) {
          try {
            await this.onInsightsGenerated(runId, projectId, result)
          } catch (err) {
            log.error('insight-webhook.failed', { runId, error: err instanceof Error ? err.message : String(err) })
          }
        }
      }
    } catch (err) {
      log.error('intelligence.failed', { runId, error: err instanceof Error ? err.message : String(err) })
    }

    // 2. Notifications — may short-circuit if no webhooks configured, catches its own errors
    try {
      await this.notifier.onRunCompleted(runId, projectId)
    } catch (err) {
      log.error('notifier.failed', { runId, error: err instanceof Error ? err.message : String(err) })
    }

    // 3. Aero — enqueue + drain so the built-in agent wakes up unprompted.
    if (this.onAeroEvent) {
      try {
        await this.onAeroEvent({ runId, projectId, insightCount, criticalOrHigh })
      } catch (err) {
        log.error('aero.failed', { runId, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}
