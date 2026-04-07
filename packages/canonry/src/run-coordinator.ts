import type { Notifier } from './notifier.js'
import type { IntelligenceService } from './intelligence-service.js'
import { createLogger } from './logger.js'

const log = createLogger('RunCoordinator')

/**
 * Post-run orchestrator that dispatches to multiple subscribers with
 * failure isolation. One subscriber failing must not starve the others.
 */
export class RunCoordinator {
  constructor(
    private notifier: Notifier,
    private intelligenceService: IntelligenceService,
  ) {}

  async onRunCompleted(runId: string, projectId: string): Promise<void> {
    // 1. Intelligence — always runs, catches its own errors.
    //    Runs first so insights are persisted before webhooks fire.
    try {
      this.intelligenceService.analyzeAndPersist(runId, projectId)
    } catch (err) {
      log.error('intelligence.failed', { runId, error: err instanceof Error ? err.message : String(err) })
    }

    // 2. Notifications — may short-circuit if no webhooks configured, catches its own errors
    try {
      await this.notifier.onRunCompleted(runId, projectId)
    } catch (err) {
      log.error('notifier.failed', { runId, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
