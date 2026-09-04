import crypto from 'node:crypto'
import cron from 'node-cron'
import { and, eq, inArray, notExists, sql } from 'drizzle-orm'
import { queueRunIfProjectIdle, nextRunFromCron, ensureCurrentQueryBasketRevision, latestQueryBasketRevision } from '@ainyc/canonry-api-routes'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { schedules, projects, runs, siteCrawlRunRequests } from '@ainyc/canonry-db'
import type { ProviderName, LocationContext, SchedulableRunKind } from '@ainyc/canonry-contracts'
import {
  SchedulableRunKinds,
  RunKinds,
  RunStatuses,
  RunTriggers,
  normalizeSiteAuditRunRequest,
  siteAuditRequestIdentity,
  describeError,
} from '@ainyc/canonry-contracts'
import { createLogger } from './logger.js'

const log = createLogger('Scheduler')

/** Default cadence for the health schedule seeded for each project. */
export const DEFAULT_HEALTH_CRON = '0 */6 * * *'

/**
 * Ensure one default doctor schedule exists for a project.
 *
 * This is deliberately callable from the project-created lifecycle hook so a
 * new project receives its schedule when it is created, not as a side effect
 * of constructing a server that may never bind. The unique project/kind index
 * makes concurrent create/startup reconciliation idempotent.
 */
export function ensureDefaultHealthSchedule(
  db: DatabaseClient,
  projectId: string,
  now = new Date().toISOString(),
): boolean {
  const result = db.insert(schedules).values({
    id: crypto.randomUUID(),
    projectId,
    kind: SchedulableRunKinds.doctor,
    cronExpr: DEFAULT_HEALTH_CRON,
    timezone: 'UTC',
    enabled: true,
    providers: [],
    nextRunAt: nextRunFromCron(DEFAULT_HEALTH_CRON, 'UTC'),
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run()
  return result.changes === 1
}

export interface SchedulerCallbacks {
  /** Fired when an answer-visibility schedule triggers. Existing canonry callsites wire this to the JobRunner. */
  onRunCreated: (runId: string, projectId: string, providers?: ProviderName[], location?: LocationContext | null) => void
  /**
   * Providers this host can actually run. A project with an empty provider
   * list means "all configured" — without this the scheduler cannot resolve
   * that to anything, and a scheduled plan sweep would have no roster to
   * measure against while a hand-triggered one worked fine.
   */
  getRunnableProviderNames?: () => readonly string[]
  /** Provider → the model this host has it pointed at, frozen onto plan runs. */
  getEffectiveProviderModels?: () => Readonly<Record<string, string>>
  /**
   * Fired when a traffic-sync schedule triggers. Receives the project's name
   * and the configured source UUID — the host wires this to the existing
   * `POST /traffic/sources/:id/sync` flow (typically via `ApiClient.trafficSync`).
   * Fire-and-forget: errors are logged by the host, not by the scheduler.
   */
  onTrafficSyncRequested?: (projectName: string, sourceId: string) => void
  /**
   * Fired when a gbp-sync schedule triggers. Unlike traffic-sync (which has the
   * endpoint own run-row creation), the scheduler creates the `gbp-sync` run
   * row here — mirroring the answer-visibility path — and hands the host the
   * `runId` so it can run the same worker the manual `POST /gbp/sync` route uses.
   * GBP needs no `sourceId`: it syncs the project's selected locations.
   * Fire-and-forget: errors are logged by the host, not by the scheduler.
   */
  onGbpSyncRequested?: (runId: string, projectId: string) => void
  /**
   * Fired when an ads-sync schedule triggers. Like gbp-sync, the scheduler
   * creates the `ads-sync` run row and hands the host the runId; the host
   * runs the same worker the manual ads-sync route uses. Ads needs no
   * `sourceId`: it syncs the project's single connected ad account.
   * Fire-and-forget: errors are logged by the host, not by the scheduler.
   */
  onAdsSyncRequested?: (runId: string, projectId: string) => void
  /**
   * Fired when a data-refresh schedule triggers. The host refreshes every
   * CONNECTED data integration (GSC, Bing, GA, GBP) for the project. Each
   * integration sync owns its own run row; per-integration errors are logged
   * by the host, not the scheduler. Fire-and-forget.
   */
  onDataRefreshRequested?: (projectName: string) => void
  /**
   * Fired when a doctor schedule triggers. The host runs the health checks and
   * decides whether the outcome is worth notifying. No run row: doctor measures
   * the instrument rather than producing findings, so it has nothing to attach
   * results to and must never displace a real sweep on the dashboard.
   * Fire-and-forget.
   */
  onDoctorRequested?: (projectName: string) => void
  /**
   * Fired when a backlinks-sync schedule triggers. The host re-probes Common
   * Crawl for the latest hyperlink-graph release and, when a newer rolling
   * window is published, runs the workspace-level release sync (which
   * auto-extracts per-project backlinks for projects with `autoExtractBacklinks`).
   * The Common Crawl sync is workspace-GLOBAL, so the scheduler creates no
   * per-project run row here — it only fires the trigger. The host owns the
   * de-dupe gate (skip when the newest release is already synced) and error
   * logging. Fire-and-forget.
   */
  onBacklinksSyncRequested?: (projectName: string) => void
  /**
   * Fired when a site-audit (Technical AEO) schedule triggers. The scheduler
   * owns run-row creation (like gbp-sync) so it can hand the host a runId; the
   * host runs the same worker the manual POST /technical-aeo/runs route uses.
   * A site-audit needs no `sourceId` / providers. Skipped (without orphaning a
   * run row) when a site-audit run is already in flight for the project, since
   * a full-site crawl can run for minutes. Fire-and-forget.
   */
  onSiteAuditRequested?: (runId: string, projectId: string) => void
}

/** Scheduler tasks are keyed by `(projectId, kind)` so a project can run an
 *  answer-visibility schedule AND a traffic-sync schedule independently. */
function taskKey(projectId: string, kind: SchedulableRunKind): string {
  return `${projectId}::${kind}`
}

export class Scheduler {
  private db: DatabaseClient
  private callbacks: SchedulerCallbacks
  private tasks = new Map<string, cron.ScheduledTask>()

  constructor(db: DatabaseClient, callbacks: SchedulerCallbacks) {
    this.db = db
    this.callbacks = callbacks
  }

  /**
   * Give every project a health schedule if it has never had one.
   *
   * Ships the schedule with the feature. The six checks that existed before
   * this had never run on a live instance because nothing scheduled them, and
   * a health check nobody enables is indistinguishable from no health check.
   *
   * Keyed on the row EXISTING, not on it being enabled, so an operator who
   * deliberately turns this off keeps it off across restarts. Seeded here
   * rather than in a migration because migrations must stay additive to remain
   * downgrade-safe, and inserting rows is a data mutation.
   *
   * Every 6h, not daily: the cadence has to be shorter than the time-to-damage
   * it guards. A Vercel source begins discarding traffic once it is 24h behind,
   * so a daily pass could only ever observe the loss after it started.
   */
  private ensureHealthSchedules(): void {
    const projectsWithoutHealth = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(notExists(
        this.db.select({ one: sql`1` }).from(schedules).where(and(
          eq(schedules.projectId, projects.id),
          eq(schedules.kind, SchedulableRunKinds.doctor),
        )),
      ))
      .all()
    if (projectsWithoutHealth.length === 0) return
    const now = new Date().toISOString()
    let seeded = 0
    for (const project of projectsWithoutHealth) {
      if (ensureDefaultHealthSchedule(this.db, project.id, now)) seeded += 1
    }
    if (seeded > 0) {
      log.info('health-schedule.seeded', { projectCount: seeded, cron: DEFAULT_HEALTH_CRON })
    }
  }

  /**
   * Record each project's current query set as basket revision 1 if it has
   * never been recorded. Minting normally happens when a sweep is queued, but a
   * project whose sweeps are manual (the common cadence: twice a month) would
   * otherwise keep its analytics on the pre-basket date heuristic for weeks
   * after the feature ships — with the chart still hiding exactly the history
   * the basket exists to recover. Boot is the moment the current set is known
   * and nothing has to be guessed, and ensureCurrentQueryBasketRevision is
   * idempotent, so restarts are no-ops and an unchanged set never churns
   * revisions. Runs are NOT stamped retroactively: the revision describes the
   * set as of now, and historical runs keep their null stamp.
   */
  private ensureQueryBaskets(): void {
    const allProjects = this.db.select({ id: projects.id }).from(projects).all()
    let minted = 0
    for (const project of allProjects) {
      try {
        const previous = latestQueryBasketRevision(this.db, project.id)?.revision ?? null
        const current = ensureCurrentQueryBasketRevision(this.db, project.id)
        if (current !== null && current.revision !== previous) minted += 1
      } catch (err) {
        log.warn('query-basket.mint-failed', { projectId: project.id, err: String(err) })
      }
    }
    if (minted > 0) log.info('query-basket.ensured', { projectCount: minted })
  }

  /** Load all enabled schedules from DB and register cron jobs. */
  start(): void {
    this.ensureHealthSchedules()
    this.ensureQueryBaskets()

    const allSchedules = this.db
      .select()
      .from(schedules)
      .where(eq(schedules.enabled, true))
      .all()

    for (const schedule of allSchedules) {
      // Capture nextRunAt before registration so the check uses the stored DB
      // value, not a value that registerCronTask might have modified.
      const missedRunAt = schedule.nextRunAt
      this.registerCronTask(schedule)

      // Catch-up: if the scheduled slot was set but the server was down when
      // it was supposed to fire, trigger immediately.
      if (missedRunAt && new Date(missedRunAt) < new Date()) {
        log.info('run.catch-up', { projectId: schedule.projectId, kind: schedule.kind, missedRunAt })
        this.triggerRun(schedule.id, schedule.projectId, schedule.kind as SchedulableRunKind)
      }
    }

    log.info('started', { scheduleCount: allSchedules.length })
  }

  /** Stop all cron tasks for graceful shutdown. */
  stop(): void {
    for (const [key, task] of this.tasks) {
      this.stopTask(key, task, 'Stopped')
    }
    this.tasks.clear()
  }

  /**
   * Add or update a cron registration at runtime (called when schedule API
   * is used). Keyed by `(projectId, kind)` so a project's traffic-sync and
   * answer-visibility schedules can coexist independently.
   */
  upsert(projectId: string, kind: SchedulableRunKind): void {
    const key = taskKey(projectId, kind)
    const existing = this.tasks.get(key)
    if (existing) {
      this.stopTask(key, existing, 'Stopped')
      this.tasks.delete(key)
    }

    const schedule = this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.projectId, projectId), eq(schedules.kind, kind)))
      .get()

    if (schedule && schedule.enabled) {
      this.registerCronTask(schedule)
    }
  }

  /** Remove a single cron registration (kind-scoped). */
  remove(projectId: string, kind: SchedulableRunKind): void {
    const key = taskKey(projectId, kind)
    const existing = this.tasks.get(key)
    if (existing) {
      this.stopTask(key, existing, 'Removed')
      this.tasks.delete(key)
    }
  }

  /** Remove ALL cron registrations for a project (used on project delete). */
  removeAllForProject(projectId: string): void {
    for (const kind of Object.values(SchedulableRunKinds)) {
      this.remove(projectId, kind)
    }
  }

  private stopTask(key: string, task: cron.ScheduledTask, verb: 'Stopped' | 'Removed'): void {
    void task.stop()
    void task.destroy()
    log.info(`task.${verb.toLowerCase()}`, { key })
  }

  private registerCronTask(schedule: typeof schedules.$inferSelect): void {
    const { id: scheduleId, projectId, cronExpr, timezone } = schedule
    const kind = schedule.kind as SchedulableRunKind

    if (!cron.validate(cronExpr)) {
      log.error('cron.invalid', { projectId, kind, cronExpr })
      return
    }

    const task = cron.schedule(cronExpr, () => {
      this.triggerRun(scheduleId, projectId, kind)
    }, {
      timezone,
    })

    this.tasks.set(taskKey(projectId, kind), task)
    this.db.update(schedules).set({
      nextRunAt: nextRunFromCron(cronExpr, timezone),
      updatedAt: new Date().toISOString(),
    }).where(eq(schedules.id, scheduleId)).run()

    const label = schedule.preset ?? cronExpr
    log.info('cron.registered', { projectId, kind, schedule: label, timezone })
  }

  private triggerRun(scheduleId: string, projectId: string, kind: SchedulableRunKind): void {
    try {
      const now = new Date().toISOString()
      const currentSchedule = this.db.select().from(schedules).where(eq(schedules.id, scheduleId)).get()
      if (!currentSchedule || !currentSchedule.enabled) {
        log.warn('schedule.stale', { scheduleId, projectId, kind, msg: 'schedule no longer exists or is disabled' })
        this.remove(projectId, kind)
        return
      }

      const nextRunAt = nextRunFromCron(currentSchedule.cronExpr, currentSchedule.timezone)

      // Check if project still exists
      const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
      if (!project) {
        log.error('project.not-found', { projectId, kind, msg: 'skipping scheduled run' })
        this.remove(projectId, kind)
        return
      }

      if (kind === SchedulableRunKinds['traffic-sync']) {
        // Traffic-sync schedules dispatch through the existing
        // POST /traffic/sources/:id/sync flow via the host-injected callback.
        // The endpoint handles run-row creation, dedupe, and rollup writes —
        // the scheduler only needs to fire the trigger.
        const sourceId = currentSchedule.sourceId
        if (!sourceId) {
          log.warn('traffic-sync.missing-source', { scheduleId, projectId })
          return
        }
        if (!this.callbacks.onTrafficSyncRequested) {
          log.warn('traffic-sync.no-callback', { scheduleId, projectId, msg: 'host did not register onTrafficSyncRequested' })
          return
        }
        this.db.update(schedules).set({
          lastRunAt: now,
          nextRunAt,
          updatedAt: now,
        }).where(eq(schedules.id, currentSchedule.id)).run()
        log.info('traffic-sync.triggered', { projectName: project.name, sourceId })
        this.callbacks.onTrafficSyncRequested(project.name, sourceId)
        return
      }

      if (kind === SchedulableRunKinds['gbp-sync']) {
        // GBP sync runs over the project's SELECTED locations — no sourceId.
        // The scheduler owns run-row creation (like answer-visibility) so it
        // can hand the host a runId; the host runs the same worker the manual
        // POST /gbp/sync route uses. Skip without orphaning a run row if the
        // host never registered the callback.
        if (!this.callbacks.onGbpSyncRequested) {
          log.warn('gbp-sync.no-callback', { scheduleId, projectId, msg: 'host did not register onGbpSyncRequested' })
          return
        }
        const runId = crypto.randomUUID()
        this.db.insert(runs).values({
          id: runId,
          projectId,
          kind: RunKinds['gbp-sync'],
          status: RunStatuses.queued,
          trigger: RunTriggers.scheduled,
          createdAt: now,
        }).run()
        this.db.update(schedules).set({
          lastRunAt: now,
          nextRunAt,
          updatedAt: now,
        }).where(eq(schedules.id, currentSchedule.id)).run()
        log.info('gbp-sync.triggered', { runId, projectName: project.name })
        this.callbacks.onGbpSyncRequested(runId, projectId)
        return
      }

      if (kind === SchedulableRunKinds['ads-sync']) {
        // Ads sync pulls the project's connected OpenAI ad account — no
        // sourceId. The scheduler owns run-row creation (like gbp-sync) so it
        // can hand the host a runId. Skip without orphaning a run row if the
        // host never registered the callback.
        if (!this.callbacks.onAdsSyncRequested) {
          log.warn('ads-sync.no-callback', { scheduleId, projectId, msg: 'host did not register onAdsSyncRequested' })
          return
        }
        // An ads sync paginates every campaign / ad-group / insight against the
        // live ad account and can run for minutes; skip (without orphaning a
        // run row) if one is already in flight so an overlapping tick cannot
        // stack passes — mirrors the site-audit guard below.
        const activeAdsRun = this.db
          .select({ id: runs.id })
          .from(runs)
          .where(and(
            eq(runs.projectId, projectId),
            eq(runs.kind, RunKinds['ads-sync']),
            inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
          ))
          .get()
        if (activeAdsRun) {
          log.info('ads-sync.skipped-active', { projectName: project.name, activeRunId: activeAdsRun.id })
          this.db.update(schedules).set({ nextRunAt, updatedAt: now }).where(eq(schedules.id, currentSchedule.id)).run()
          return
        }
        const runId = crypto.randomUUID()
        this.db.insert(runs).values({
          id: runId,
          projectId,
          kind: RunKinds['ads-sync'],
          status: RunStatuses.queued,
          trigger: RunTriggers.scheduled,
          createdAt: now,
        }).run()
        this.db.update(schedules).set({
          lastRunAt: now,
          nextRunAt,
          updatedAt: now,
        }).where(eq(schedules.id, currentSchedule.id)).run()
        log.info('ads-sync.triggered', { runId, projectName: project.name })
        this.callbacks.onAdsSyncRequested(runId, projectId)
        return
      }

      if (kind === SchedulableRunKinds['data-refresh']) {
        // Data-refresh schedules fan out to every connected data integration
        // (GSC, Bing, GA, GBP) via the host callback. Each integration sync
        // owns its own run row + dedupe; the scheduler only fires the trigger.
        if (!this.callbacks.onDataRefreshRequested) {
          log.warn('data-refresh.no-callback', { scheduleId, projectId, msg: 'host did not register onDataRefreshRequested' })
          return
        }
        this.db.update(schedules).set({
          lastRunAt: now,
          nextRunAt,
          updatedAt: now,
        }).where(eq(schedules.id, currentSchedule.id)).run()
        log.info('data-refresh.triggered', { projectName: project.name })
        this.callbacks.onDataRefreshRequested(project.name)
        return
      }

      if (kind === SchedulableRunKinds.doctor) {
        // Health checks read existing state and emit at most one notification;
        // they create no run row, so the schedule row itself is the only thing
        // that advances here.
        if (!this.callbacks.onDoctorRequested) {
          log.warn('doctor.no-callback', { scheduleId, projectId, msg: 'host did not register onDoctorRequested' })
          return
        }
        this.db.update(schedules).set({
          lastRunAt: now,
          nextRunAt,
          updatedAt: now,
        }).where(eq(schedules.id, currentSchedule.id)).run()
        log.info('doctor.triggered', { projectName: project.name })
        this.callbacks.onDoctorRequested(project.name)
        return
      }

      if (kind === SchedulableRunKinds['backlinks-sync']) {
        // Backlinks-sync re-probes Common Crawl and runs the workspace-level
        // release sync when a newer rolling window is published. The sync is
        // workspace-global (no per-project run row); the host owns the
        // probe + de-dupe gate + trigger. Skip without side effects if the
        // host never registered the callback.
        if (!this.callbacks.onBacklinksSyncRequested) {
          log.warn('backlinks-sync.no-callback', { scheduleId, projectId, msg: 'host did not register onBacklinksSyncRequested' })
          return
        }
        this.db.update(schedules).set({
          lastRunAt: now,
          nextRunAt,
          updatedAt: now,
        }).where(eq(schedules.id, currentSchedule.id)).run()
        log.info('backlinks-sync.triggered', { projectName: project.name })
        this.callbacks.onBacklinksSyncRequested(project.name)
        return
      }

      if (kind === SchedulableRunKinds['site-audit']) {
        // Technical AEO: crawl root, sitemap, and linked pages. Like
        // gbp-sync, the scheduler creates the run row and hands the host a
        // runId. A full-site crawl can run for minutes, so skip (without
        // orphaning a run row) when one is already queued/running.
        if (!this.callbacks.onSiteAuditRequested) {
          log.warn('site-audit.no-callback', { scheduleId, projectId, msg: 'host did not register onSiteAuditRequested' })
          return
        }
        const active = this.db
          .select({ id: runs.id })
          .from(runs)
          .where(and(
            eq(runs.projectId, projectId),
            eq(runs.kind, RunKinds['site-audit']),
            inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
          ))
          .get()
        if (active) {
          log.info('site-audit.skipped-active', { projectName: project.name, activeRunId: active.id })
          this.db.update(schedules).set({ nextRunAt, updatedAt: now }).where(eq(schedules.id, currentSchedule.id)).run()
          return
        }
        const runId = crypto.randomUUID()
        const effectiveRequest = normalizeSiteAuditRunRequest({})
        this.db.transaction((tx) => {
          tx.insert(runs).values({
            id: runId,
            projectId,
            kind: RunKinds['site-audit'],
            status: RunStatuses.queued,
            trigger: RunTriggers.scheduled,
            createdAt: now,
          }).run()
          tx.insert(siteCrawlRunRequests).values({
            runId,
            projectId,
            identityKey: siteAuditRequestIdentity(effectiveRequest),
            effectiveOptions: effectiveRequest,
            createdAt: now,
          }).run()
        })
        this.db.update(schedules).set({
          lastRunAt: now,
          nextRunAt,
          updatedAt: now,
        }).where(eq(schedules.id, currentSchedule.id)).run()
        log.info('site-audit.triggered', { runId, projectName: project.name })
        this.callbacks.onSiteAuditRequested(runId, projectId)
        return
      }

      // answer-visibility (default) — original flow.
      const projectLocations = project.locations
      let resolvedLocation: LocationContext | undefined
      if (project.defaultLocation) {
        const loc = projectLocations.find(l => l.label === project.defaultLocation)
        if (!loc) {
          log.warn('default-location.stale', { scheduleId, projectId, label: project.defaultLocation })
          return
        }
        resolvedLocation = loc
      }
      const locationLabel = resolvedLocation?.label ?? null

      // Resolve providers before queuing: a plan-aware run records what it
      // expects to produce, and a schedule that pins its own providers expects
      // those, not the project's whole list.
      const scheduleProviders = currentSchedule.providers
      const providers = scheduleProviders.length > 0 ? scheduleProviders : undefined

      const queueResult = queueRunIfProjectIdle(this.db, {
        createdAt: now,
        kind: 'answer-visibility',
        projectId,
        trigger: 'scheduled',
        location: locationLabel,
        providers,
        runnableProviders: this.callbacks.getRunnableProviderNames?.(),
        providerModels: this.callbacks.getEffectiveProviderModels?.(),
      })

      if (queueResult.conflict) {
        log.info('run.skipped-active', { projectName: project.name, activeRunId: queueResult.activeRunId })
        this.db.update(schedules).set({
          nextRunAt,
          updatedAt: now,
        }).where(eq(schedules.id, currentSchedule.id)).run()
        return
      }

      const runId = queueResult.runId
      this.db.update(schedules).set({
        lastRunAt: now,
        nextRunAt,
        updatedAt: now,
      }).where(eq(schedules.id, currentSchedule.id)).run()

      log.info('run.triggered', { runId, projectName: project.name, providers: providers ?? 'all' })
      this.callbacks.onRunCreated(runId, projectId, providers, resolvedLocation)
    } catch (err: unknown) {
      log.error('trigger.error', { scheduleId, projectId, kind, error: describeError(err) })
    }
  }
}
