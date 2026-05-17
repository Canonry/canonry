import cron from 'node-cron'
import { and, eq } from 'drizzle-orm'
import { queueRunIfProjectIdle } from '@ainyc/canonry-api-routes'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { schedules, projects, parseJsonColumn } from '@ainyc/canonry-db'
import type { ProviderName, LocationContext, SchedulableRunKind } from '@ainyc/canonry-contracts'
import { SchedulableRunKinds } from '@ainyc/canonry-contracts'
import { createLogger } from './logger.js'

const log = createLogger('Scheduler')

export interface SchedulerCallbacks {
  /** Fired when an answer-visibility schedule triggers. Existing canonry callsites wire this to the JobRunner. */
  onRunCreated: (runId: string, projectId: string, providers?: ProviderName[], location?: LocationContext | null) => void
  /**
   * Fired when a traffic-sync schedule triggers. Receives the project's name
   * and the configured source UUID — the host wires this to the existing
   * `POST /traffic/sources/:id/sync` flow (typically via `ApiClient.trafficSync`).
   * Fire-and-forget: errors are logged by the host, not by the scheduler.
   */
  onTrafficSyncRequested?: (projectName: string, sourceId: string) => void
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

  /** Load all enabled schedules from DB and register cron jobs. */
  start(): void {
    const allSchedules = this.db
      .select()
      .from(schedules)
      .where(eq(schedules.enabled, 1))
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

    if (schedule && schedule.enabled === 1) {
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
      nextRunAt: task.getNextRun()?.toISOString() ?? null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schedules.id, scheduleId)).run()

    const label = schedule.preset ?? cronExpr
    log.info('cron.registered', { projectId, kind, schedule: label, timezone })
  }

  private triggerRun(scheduleId: string, projectId: string, kind: SchedulableRunKind): void {
    try {
      const now = new Date().toISOString()
      const currentSchedule = this.db.select().from(schedules).where(eq(schedules.id, scheduleId)).get()
      if (!currentSchedule || currentSchedule.enabled !== 1) {
        log.warn('schedule.stale', { scheduleId, projectId, kind, msg: 'schedule no longer exists or is disabled' })
        this.remove(projectId, kind)
        return
      }

      const task = this.tasks.get(taskKey(projectId, kind))
      const nextRunAt = task?.getNextRun()?.toISOString() ?? null

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

      const queueResult = queueRunIfProjectIdle(this.db, {
        createdAt: now,
        kind: 'answer-visibility',
        projectId,
        trigger: 'scheduled',
        location: locationLabel,
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

      // Resolve providers
      const scheduleProviders = parseJsonColumn<string[]>(currentSchedule.providers, [])
      const providers = scheduleProviders.length > 0 ? scheduleProviders as ProviderName[] : undefined

      log.info('run.triggered', { runId, projectName: project.name, providers: providers ?? 'all' })
      this.callbacks.onRunCreated(runId, projectId, providers, resolvedLocation)
    } catch (err: unknown) {
      log.error('trigger.error', { scheduleId, projectId, kind, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
