import crypto from 'node:crypto'
import cron from 'node-cron'
import { eq, and, or } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/aeo-platform-db'
import { schedules, runs, projects } from '@ainyc/aeo-platform-db'
import type { ProviderName } from '@ainyc/aeo-platform-contracts'

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
      this.registerCronTask(schedule)

      // Catch-up: if nextRunAt is in the past, trigger immediately
      if (schedule.nextRunAt) {
        const nextRun = new Date(schedule.nextRunAt)
        if (nextRun < new Date()) {
          console.log(`[Scheduler] Catch-up run for project ${schedule.projectId} (missed ${schedule.nextRunAt})`)
          this.triggerRun(schedule)
        }
      }
    }

    console.log(`[Scheduler] Started with ${allSchedules.length} schedule(s)`)
  }

  /** Stop all cron tasks for graceful shutdown. */
  stop(): void {
    for (const [projectId, task] of this.tasks) {
      task.stop()
      console.log(`[Scheduler] Stopped task for project ${projectId}`)
    }
    this.tasks.clear()
  }

  /** Add or update a cron registration at runtime (called when schedule API is used). */
  upsert(projectId: string): void {
    // Remove existing task if any
    const existing = this.tasks.get(projectId)
    if (existing) {
      existing.stop()
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
      existing.stop()
      this.tasks.delete(projectId)
      console.log(`[Scheduler] Removed task for project ${projectId}`)
    }
  }

  private registerCronTask(schedule: typeof schedules.$inferSelect): void {
    const { projectId, cronExpr, timezone } = schedule

    if (!cron.validate(cronExpr)) {
      console.error(`[Scheduler] Invalid cron expression for project ${projectId}: ${cronExpr}`)
      return
    }

    const task = cron.schedule(cronExpr, () => {
      this.triggerRun(schedule)
    }, {
      timezone,
    })

    this.tasks.set(projectId, task)

    // Compute and store next run time
    const nextRunAt = new Date()
    nextRunAt.setMinutes(nextRunAt.getMinutes() + 1) // approximate — node-cron doesn't expose next tick
    this.db.update(schedules).set({
      nextRunAt: nextRunAt.toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(eq(schedules.id, schedule.id)).run()

    const label = schedule.preset ?? cronExpr
    console.log(`[Scheduler] Registered "${label}" (${timezone}) for project ${projectId}`)
  }

  private triggerRun(schedule: typeof schedules.$inferSelect): void {
    const { projectId } = schedule
    const now = new Date().toISOString()

    // Check if project still exists
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      console.error(`[Scheduler] Project ${projectId} not found, skipping scheduled run`)
      return
    }

    // Check for active runs (prevent duplicates)
    const activeRun = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(eq(runs.status, 'queued'), eq(runs.status, 'running')),
        ),
      )
      .get()

    if (activeRun) {
      console.log(`[Scheduler] Skipping scheduled run for ${project.name} — run ${activeRun.id} already active`)
      return
    }

    // Create the run
    const runId = crypto.randomUUID()
    this.db.insert(runs).values({
      id: runId,
      projectId,
      kind: 'answer-visibility',
      status: 'queued',
      trigger: 'scheduled',
      createdAt: now,
    }).run()

    // Update schedule timestamps
    this.db.update(schedules).set({
      lastRunAt: now,
      updatedAt: now,
    }).where(eq(schedules.id, schedule.id)).run()

    // Resolve providers
    const scheduleProviders = JSON.parse(schedule.providers) as string[]
    const providers = scheduleProviders.length > 0 ? scheduleProviders as ProviderName[] : undefined

    console.log(`[Scheduler] Triggered scheduled run ${runId} for project ${project.name}`)
    this.callbacks.onRunCreated(runId, projectId, providers)
  }
}
