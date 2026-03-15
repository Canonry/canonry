import cron from 'node-cron'
import { eq } from 'drizzle-orm'
import { queueRunIfProjectIdle } from '@ainyc/canonry-api-routes'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { schedules, projects } from '@ainyc/canonry-db'
import type { ProviderName } from '@ainyc/canonry-contracts'

export interface SchedulerCallbacks {
  onRunCreated: (runId: string, projectId: string, providers?: ProviderName[]) => void
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
        console.log(`[Scheduler] Catch-up run for project ${schedule.projectId} (missed ${missedRunAt})`)
        this.triggerRun(schedule.id, schedule.projectId)
      }
    }

    console.log(`[Scheduler] Started with ${allSchedules.length} schedule(s)`)
  }

  /** Stop all cron tasks for graceful shutdown. */
  stop(): void {
    for (const [projectId, task] of this.tasks) {
      this.stopTask(projectId, task, 'Stopped')
    }
    this.tasks.clear()
  }

  /** Add or update a cron registration at runtime (called when schedule API is used). */
  upsert(projectId: string): void {
    // Remove existing task if any
    const existing = this.tasks.get(projectId)
    if (existing) {
      this.stopTask(projectId, existing, 'Stopped')
      this.tasks.delete(projectId)
    }

    // Load fresh from DB
    const schedule = this.db
      .select()
      .from(schedules)
      .where(eq(schedules.projectId, projectId))
      .get()

    if (schedule && schedule.enabled === 1) {
      this.registerCronTask(schedule)
    }
  }

  /** Remove a cron registration (called when schedule is deleted). */
  remove(projectId: string): void {
    const existing = this.tasks.get(projectId)
    if (existing) {
      this.stopTask(projectId, existing, 'Removed')
      this.tasks.delete(projectId)
    }
  }

  private stopTask(projectId: string, task: cron.ScheduledTask, verb: 'Stopped' | 'Removed'): void {
    task.stop()
    task.destroy()
    console.log(`[Scheduler] ${verb} task for project ${projectId}`)
  }

  private registerCronTask(schedule: typeof schedules.$inferSelect): void {
    const { id: scheduleId, projectId, cronExpr, timezone } = schedule

    if (!cron.validate(cronExpr)) {
      console.error(`[Scheduler] Invalid cron expression for project ${projectId}: ${cronExpr}`)
      return
    }

    const task = cron.schedule(cronExpr, () => {
      this.triggerRun(scheduleId, projectId)
    }, {
      timezone,
    })

    this.tasks.set(projectId, task)
    this.db.update(schedules).set({
      nextRunAt: task.getNextRun()?.toISOString() ?? null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schedules.id, scheduleId)).run()

    const label = schedule.preset ?? cronExpr
    console.log(`[Scheduler] Registered "${label}" (${timezone}) for project ${projectId}`)
  }

  private triggerRun(scheduleId: string, projectId: string): void {
    const now = new Date().toISOString()
    const currentSchedule = this.db.select().from(schedules).where(eq(schedules.id, scheduleId)).get()
    if (!currentSchedule || currentSchedule.enabled !== 1) {
      console.log(`[Scheduler] Schedule ${scheduleId} no longer exists or is disabled, removing task for project ${projectId}`)
      this.remove(projectId)
      return
    }

    const task = this.tasks.get(projectId)
    const nextRunAt = task?.getNextRun()?.toISOString() ?? null

    // Check if project still exists
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      console.error(`[Scheduler] Project ${projectId} not found, skipping scheduled run`)
      this.remove(projectId)
      return
    }

    const queueResult = queueRunIfProjectIdle(this.db, {
      createdAt: now,
      kind: 'answer-visibility',
      projectId,
      trigger: 'scheduled',
    })

    if (queueResult.conflict) {
      console.log(`[Scheduler] Skipping scheduled run for ${project.name} — run ${queueResult.activeRunId} already active`)
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
    const scheduleProviders = JSON.parse(currentSchedule.providers) as string[]
    const providers = scheduleProviders.length > 0 ? scheduleProviders as ProviderName[] : undefined

    console.log(`[Scheduler] Triggered scheduled run ${runId} for project ${project.name}`)
    this.callbacks.onRunCreated(runId, projectId, providers)
  }
}
