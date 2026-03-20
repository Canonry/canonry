import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schedules } from '@ainyc/canonry-db'
import {
  type ScheduleDto,
  type ProviderName,
  scheduleUpsertRequestSchema,
  validationError,
} from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import { resolvePreset, validateCron, isValidTimezone } from './schedule-utils.js'

export interface ScheduleRoutesOptions {
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string) => void
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
}

export async function scheduleRoutes(app: FastifyInstance, opts: ScheduleRoutesOptions) {
  // PUT /projects/:name/schedule — create or update schedule
  app.put<{
    Params: { name: string }
    Body: { preset?: string; cron?: string; timezone?: string; providers?: string[]; enabled?: boolean }
  }>('/projects/:name/schedule', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const parsedBody = scheduleUpsertRequestSchema.safeParse(request.body)
    if (!parsedBody.success) {
      const err = validationError('Invalid schedule payload', {
        issues: parsedBody.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
      return reply.status(err.statusCode).send(err.toJSON())
    }
    const { preset, cron, timezone, providers, enabled } = parsedBody.data

    // Validate provider names against registered adapters
    const validNames = opts.validProviderNames ?? []
    if (validNames.length && providers?.length) {
      const invalid = providers.filter(p => !validNames.includes(p))
      if (invalid.length) {
        const err = validationError(`Invalid provider(s): ${invalid.join(', ')}. Must be one of: ${validNames.join(', ')}`, {
          invalidProviders: invalid,
          validProviders: validNames,
        })
        return reply.status(err.statusCode).send(err.toJSON())
      }
    }

    if (!isValidTimezone(timezone)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `Invalid timezone: ${timezone}` },
      })
    }

    let cronExpr: string
    if (preset) {
      try {
        cronExpr = resolvePreset(preset)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: msg } })
      }
    } else {
      cronExpr = cron!
      if (!validateCron(cronExpr)) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: `Invalid cron expression: ${cronExpr}` },
        })
      }
    }

    const now = new Date().toISOString()
    const enabledInt = enabled === false ? 0 : 1
    const existing = app.db.select().from(schedules).where(eq(schedules.projectId, project.id)).get()

    if (existing) {
      app.db.update(schedules).set({
        cronExpr,
        preset: preset ?? null,
        timezone,
        providers: JSON.stringify(providers),
        enabled: enabledInt,
        updatedAt: now,
      }).where(eq(schedules.id, existing.id)).run()
    } else {
      app.db.insert(schedules).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        cronExpr,
        preset: preset ?? null,
        timezone,
        enabled: enabledInt,
        providers: JSON.stringify(providers),
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: existing ? 'schedule.updated' : 'schedule.created',
      entityType: 'schedule',
      diff: { cronExpr, preset, timezone, providers },
    })

    opts.onScheduleUpdated?.('upsert', project.id)

    const schedule = app.db.select().from(schedules).where(eq(schedules.projectId, project.id)).get()!
    return reply.status(existing ? 200 : 201).send(formatSchedule(schedule))
  })

  // GET /projects/:name/schedule — get schedule
  app.get<{ Params: { name: string } }>('/projects/:name/schedule', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const schedule = app.db.select().from(schedules).where(eq(schedules.projectId, project.id)).get()
    if (!schedule) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No schedule for project '${request.params.name}'` } })
    }

    return reply.send(formatSchedule(schedule))
  })

  // DELETE /projects/:name/schedule — remove schedule
  app.delete<{ Params: { name: string } }>('/projects/:name/schedule', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const schedule = app.db.select().from(schedules).where(eq(schedules.projectId, project.id)).get()
    if (!schedule) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No schedule for project '${request.params.name}'` } })
    }

    app.db.delete(schedules).where(eq(schedules.id, schedule.id)).run()

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'schedule.deleted',
      entityType: 'schedule',
      entityId: schedule.id,
    })

    opts.onScheduleUpdated?.('delete', project.id)

    return reply.status(204).send()
  })
}

function formatSchedule(row: typeof schedules.$inferSelect): ScheduleDto {
  return {
    id: row.id,
    projectId: row.projectId,
    cronExpr: row.cronExpr,
    preset: row.preset,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    providers: JSON.parse(row.providers) as ProviderName[],
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function resolveProjectSafe(app: FastifyInstance, name: string, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  try {
    return resolveProject(app.db, name)
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
      const err = e as { statusCode: number; toJSON(): unknown }
      reply.status(err.statusCode).send(err.toJSON())
      return null
    }
    throw e
  }
}
