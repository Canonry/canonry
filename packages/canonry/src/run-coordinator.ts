import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { discoverySessions, runs } from '@ainyc/canonry-db'
import {
  RunKinds,
  RunTriggers,
  type DiscoveryCompetitorMapEntry,
  type RunKind,
} from '@ainyc/canonry-contracts'
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
 *
 * The `kind`-tagged union lets `server.ts` build a payload that fits the
 * run type: visibility runs cite insight counts; `aeo-discover-probe` runs
 * cite bucket counts, the seed provider, and the discovery session ID so
 * Aero can pull the per-query breakdown without a follow-up tool call.
 */
export type OnAeroEvent = (ctx: AeroEventContext) => Promise<void>

export type AeroEventContext =
  | {
      kind: typeof RunKinds['aeo-discover-probe']
      runId: string
      projectId: string
      sessionId: string
      seedProvider: string | null
      buckets: { cited: number; aspirational: number; 'wasted-surface': number }
      probeCount: number
      topCompetitors: DiscoveryCompetitorMapEntry[]
      status: 'completed' | 'failed'
      error: string | null
    }
  | {
      kind: Exclude<RunKind, typeof RunKinds['aeo-discover-probe']>
      runId: string
      projectId: string
      insightCount: number
      criticalOrHigh: number
    }

/**
 * Post-run orchestrator that dispatches to multiple subscribers with
 * failure isolation. One subscriber failing must not starve the others.
 */
export class RunCoordinator {
  constructor(
    private db: DatabaseClient,
    private notifier: Notifier,
    private intelligenceService: IntelligenceService,
    private onInsightsGenerated?: (runId: string, projectId: string, result: AnalysisResult) => Promise<void>,
    private onAeroEvent?: OnAeroEvent,
  ) {}

  async onRunCompleted(runId: string, projectId: string): Promise<void> {
    const runRow = this.db.select().from(runs).where(eq(runs.id, runId)).get()
    const kind = (runRow?.kind ?? RunKinds['answer-visibility']) as RunKind

    // Probe runs are operator/agent test runs — they write snapshots so the
    // operator can inspect what the provider returned, but they must not
    // displace real data: no intelligence analysis, no notifier webhooks,
    // no Aero wake-up. Skip the entire post-run pipeline. The dashboard +
    // analytics endpoints filter trigger='probe' separately so the snapshots
    // never feed aggregations either.
    if (runRow?.trigger === RunTriggers.probe) {
      log.info('probe.skip-side-effects', { runId, projectId, kind })
      return
    }

    let insightCount = 0
    let criticalOrHigh = 0

    // 1. Intelligence — only meaningful for answer-visibility runs that have
    //    query_snapshots to analyse. Discovery and integration-sync runs are
    //    skipped here: discovery writes its own insight directly from the
    //    job handler, and integration syncs don't produce visibility data.
    if (kind === RunKinds['answer-visibility']) {
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
        const ctx: AeroEventContext = kind === RunKinds['aeo-discover-probe']
          ? this.buildDiscoveryAeroContext(runId, projectId, runRow?.status === 'failed' ? 'failed' : 'completed', runRow?.error ?? null)
          : {
              kind: kind as Exclude<RunKind, typeof RunKinds['aeo-discover-probe']>,
              runId,
              projectId,
              insightCount,
              criticalOrHigh,
            }
        await this.onAeroEvent(ctx)
      } catch (err) {
        log.error('aero.failed', { runId, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  /**
   * Pull the discovery session that owns this run and project a payload Aero
   * can act on: bucket counts, top competitors, the seed provider, and the
   * session ID it can pass to `canonry_discover_session_get` for the per-query
   * breakdown. Looked up by `runId` (the POST handler populates
   * `discovery_sessions.runId` in the same transaction that creates the run)
   * so two concurrent discovery sessions on the same project don't get
   * cross-wired. Falls back to a zero payload when the session row is missing
   * so the Aero queue is never starved of a follow-up.
   */
  private buildDiscoveryAeroContext(
    runId: string,
    projectId: string,
    status: 'completed' | 'failed',
    error: string | null,
  ): AeroEventContext {
    const session = this.db
      .select()
      .from(discoverySessions)
      .where(eq(discoverySessions.runId, runId))
      .get()

    const competitorMap = session ? session.competitorMap : []

    return {
      kind: RunKinds['aeo-discover-probe'],
      runId,
      projectId,
      sessionId: session?.id ?? '',
      seedProvider: session?.seedProvider ?? null,
      buckets: {
        cited: session?.citedCount ?? 0,
        aspirational: session?.aspirationalCount ?? 0,
        'wasted-surface': session?.wastedCount ?? 0,
      },
      probeCount: session?.probeCount ?? 0,
      topCompetitors: competitorMap.slice(0, 5),
      status,
      error,
    }
  }
}
