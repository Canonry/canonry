import crypto from 'node:crypto'
import { and, eq, lt, ne, or } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { discoverySessions, projects, providerTokenUsage, querySnapshots, runs } from '@ainyc/canonry-db'
import {
  RunKinds,
  RunStatuses,
  RunTriggers,
  type DiscoveryCompetitorMapEntry,
  type RunKind,
} from '@ainyc/canonry-contracts'
import { emitCloudEvent } from '@ainyc/canonry-api-routes'
import type { Notifier } from './notifier.js'
import type { IntelligenceService } from './intelligence-service.js'
import type { AnalysisResult, Insight } from '@ainyc/canonry-intelligence'
import { createLogger } from './logger.js'
import { extractTokenUsage } from './token-usage.js'

const log = createLogger('RunCoordinator')

/**
 * Fixed UUID namespace for `baseline.completed` / future stable-id cloud
 * events. The actual value doesn't matter — it just needs to stay
 * constant so the same `(eventType, projectId)` always derives the same
 * v5 UUID. Arbitrary v4 UUID picked once and frozen.
 */
const CLOUD_EVENT_NAMESPACE = Buffer.from(
  '5ba7b811-9dad-11d1-80b4-00c04fd430c8'.replace(/-/g, ''),
  'hex',
)

/**
 * Derive a deterministic RFC 4122 v5 UUID from `(eventType, projectId)`.
 * Same inputs always yield the same UUID, so the control plane's
 * `event_idempotency` table collapses accidental duplicates regardless of
 * how many times the tenant emits.
 *
 * Exported for unit testing; production callers go through the
 * `stableEventId('baseline.completed', projectId)` site inside this module.
 */
export function stableEventId(eventType: string, projectId: string): string {
  const hash = crypto.createHash('sha1')
  hash.update(CLOUD_EVENT_NAMESPACE)
  hash.update(`${eventType}:${projectId}`)
  const bytes = hash.digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

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
    } else if (kind === RunKinds['gbp-sync']) {
      // GBP sync runs produce location-scoped local-AEO insights (lodging gaps,
      // missing direct-booking CTAs, metric/keyword drops). The notifier + Aero
      // steps below pick them up from the DB the same way they do visibility
      // insights — no extra wiring once they're persisted.
      try {
        const gbpInsights = this.intelligenceService.analyzeAndPersistGbp(runId, projectId)
        insightCount = gbpInsights.length
        criticalOrHigh = gbpInsights.filter(
          i => i.severity === 'critical' || i.severity === 'high',
        ).length

        if (this.onInsightsGenerated && criticalOrHigh > 0) {
          try {
            await this.onInsightsGenerated(runId, projectId, analysisResultFromInsights(gbpInsights))
          } catch (err) {
            log.error('gbp-insight-webhook.failed', { runId, error: err instanceof Error ? err.message : String(err) })
          }
        }
      } catch (err) {
        log.error('gbp-intelligence.failed', { runId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // 2. Cloud baseline event — fire `baseline.completed` exactly once per
    //    project, on the first answer-visibility run that lands in a
    //    terminal-success state. Subsequent runs don't re-emit. Subscribers
    //    are typically the bootstrap-registered control plane; OSS
    //    deployments emit but no one listens. Failures are swallowed —
    //    falling through to notifier/Aero is more important than reaching
    //    every cloud subscriber.
    if (
      kind === RunKinds['answer-visibility'] &&
      runRow &&
      (runRow.status === RunStatuses.completed || runRow.status === RunStatuses.partial)
    ) {
      try {
        await this.maybeEmitBaselineCompleted(runRow, projectId)
      } catch (err) {
        log.error('cloud.baseline-completed.failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // 3. Token-cost telemetry (Track 1 — Canonry Hosted). Persist a
    //    per-(provider, model) usage row for every query snapshot in this run
    //    that carries a usage block. Best-effort: persistence failures log
    //    but never block the rest of the post-run pipeline. OSS deployments
    //    silently accumulate the rows — the cloud control plane is the
    //    primary consumer (billing + cost dashboards). Skipped for browser
    //    providers and snapshots written before the extractor shipped.
    if (kind === RunKinds['answer-visibility']) {
      try {
        this.persistTokenUsage(runId, projectId)
      } catch (err) {
        log.error('token-usage.failed', { runId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // 4. Notifications — may short-circuit if no webhooks configured, catches its own errors
    try {
      await this.notifier.onRunCompleted(runId, projectId)
    } catch (err) {
      log.error('notifier.failed', { runId, error: err instanceof Error ? err.message : String(err) })
    }

    // 5. Aero — enqueue + drain so the built-in agent wakes up unprompted.
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
   * Track 3 (Canonry Hosted) — emit `baseline.completed` if this is the
   * first successful answer-visibility run for the project. "First" is
   * defined as: no other `completed` or `partial` answer-visibility run
   * exists for this project that is strictly older by `createdAt`. Probe
   * runs are excluded so an operator smoke-test doesn't masquerade as the
   * baseline.
   *
   * Concurrent-completion races (two answer-visibility runs finishing at
   * once, or an older-but-longer-running run completing AFTER a newer one)
   * can still produce a second emit because the lookup is non-atomic. To
   * keep the control plane's `event_idempotency` table doing the right
   * thing, we derive a STABLE `event_id` from `(event, projectId)` — every
   * baseline emission for the same project carries the same UUID, so the
   * control plane collapses accidental duplicates without depending on
   * tenant-side serialization.
   */
  private async maybeEmitBaselineCompleted(
    runRow: typeof runs.$inferSelect,
    projectId: string,
  ): Promise<void> {
    // Look for any earlier completed/partial answer-visibility run for
    // this project that isn't a probe. If one exists, this isn't the
    // baseline.
    const earlier = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.kind, RunKinds['answer-visibility']),
          ne(runs.trigger, RunTriggers.probe),
          or(eq(runs.status, RunStatuses.completed), eq(runs.status, RunStatuses.partial)),
          ne(runs.id, runRow.id),
          lt(runs.createdAt, runRow.createdAt),
        ),
      )
      .limit(1)
      .get()
    if (earlier) return

    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      log.warn('cloud.baseline-completed.project-missing', { runId: runRow.id, projectId })
      return
    }

    await emitCloudEvent(this.db, {
      event: 'baseline.completed',
      project: { id: project.id, name: project.name, canonicalDomain: project.canonicalDomain },
      payload: {
        runId: runRow.id,
        reportSummary: {
          status: runRow.status,
          finishedAt: runRow.finishedAt,
          kind: runRow.kind,
        },
      },
      eventId: stableEventId('baseline.completed', projectId),
    })
    log.info('cloud.baseline-completed.emitted', { runId: runRow.id, projectId })
  }

  /**
   * Track 1 (Canonry Hosted) — persist per-(provider, model) token-cost
   * telemetry for a completed run.
   *
   * Reads every `query_snapshots` row for this run, asks the provider-aware
   * extractor for a `{ inputTokens, outputTokens, cachedInputTokens }`
   * triple, and rolls them up by `(provider, model)` so one row covers all
   * the queries that fanned out to the same model. Snapshots without a
   * recognized usage block (browser providers, older rows from before
   * instrumentation shipped) are skipped — we don't write zero-counter
   * rows that would dilute downstream cost dashboards.
   *
   * Writes happen synchronously inside a single transaction so a partial
   * failure rolls back. The caller wraps this in a try/catch so a
   * persistence error logs but never blocks the rest of the run-completion
   * pipeline.
   */
  private persistTokenUsage(runId: string, projectId: string): void {
    const snapshots = this.db
      .select({
        provider: querySnapshots.provider,
        model: querySnapshots.model,
        rawResponse: querySnapshots.rawResponse,
      })
      .from(querySnapshots)
      .where(eq(querySnapshots.runId, runId))
      .all()

    if (snapshots.length === 0) return

    type Bucket = { provider: string; model: string | null; input: number; output: number; cached: number }
    const buckets = new Map<string, Bucket>()

    for (const snap of snapshots) {
      if (!snap.rawResponse) continue
      const usage = extractTokenUsage(snap.provider, snap.rawResponse)
      if (!usage) continue
      const key = `${snap.provider}::${snap.model ?? ''}`
      const existing = buckets.get(key)
      if (existing) {
        existing.input += usage.inputTokens
        existing.output += usage.outputTokens
        existing.cached += usage.cachedInputTokens
      } else {
        buckets.set(key, {
          provider: snap.provider,
          model: snap.model,
          input: usage.inputTokens,
          output: usage.outputTokens,
          cached: usage.cachedInputTokens,
        })
      }
    }

    if (buckets.size === 0) return

    const now = new Date().toISOString()
    this.db.transaction((tx) => {
      for (const bucket of buckets.values()) {
        tx.insert(providerTokenUsage).values({
          id: crypto.randomUUID(),
          runId,
          projectId,
          provider: bucket.provider,
          model: bucket.model,
          inputTokens: bucket.input,
          outputTokens: bucket.output,
          cachedInputTokens: bucket.cached,
          occurredAt: now,
        }).run()
      }
    })

    log.info('token-usage.persisted', { runId, projectId, bucketCount: buckets.size })
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

function analysisResultFromInsights(insights: Insight[]): AnalysisResult {
  return {
    regressions: [],
    gains: [],
    firstCitations: [],
    providerPickups: [],
    persistentGaps: [],
    competitorGains: [],
    competitorLosses: [],
    health: {
      overallCitedRate: 0,
      totalPairs: 0,
      citedPairs: 0,
      providerBreakdown: {},
    },
    insights,
  }
}
