import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schedules, trafficSources } from '@ainyc/canonry-db'
import {
  type ScheduleDto,
  type ProviderName,
  type SchedulableRunKind,
  SchedulableRunKinds,
  schedulableRunKindSchema,
  scheduleUpsertRequestSchema,
  validationError,
  notFound,
} from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'
import { resolvePreset, validateCron, isValidTimezone } from './schedule-utils.js'

/**
 * Resolve the optional `?kind=` query into a SchedulableRunKind. Defaults to
 * 'answer-visibility' so the legacy single-schedule API surface keeps working
 * unchanged for callers that pre-date the kind dimension.
 */
function parseKindParam(raw: unknown): SchedulableRunKind {
  if (raw === undefined || raw === null || raw === '') return SchedulableRunKinds['answer-visibility']
  const parsed = schedulableRunKindSchema.safeParse(raw)
  if (!parsed.success) {
    throw validationError(`Invalid kind "${JSON.stringify(raw)}". Must be one of: ${Object.values(SchedulableRunKinds).join(', ')}`)
  }
  return parsed.data
}

export interface ScheduleRoutesOptions {
  /**
   * Notification fired after a schedule is created/updated/deleted. The `kind`
   * parameter scopes the change so the host's scheduler can register or
   * remove a per-(project, kind) cron task. Hosts that pre-date the kind
   * dimension can ignore it.
   */
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string, kind: SchedulableRunKind) => void
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
}

export async function scheduleRoutes(app: FastifyInstance, opts: ScheduleRoutesOptions) {
  // PUT /projects/:name/schedule — create or update schedule.
  // Optional `kind` body field (or `?kind=` query) selects which run kind
  // this schedule dispatches. Defaults to 'answer-visibility' for backward
  // compatibility with callers that predate the kind dimension.
  app.put<{
    Params: { name: string }
    Querystring: { kind?: string }
    Body: { kind?: string; preset?: string; cron?: string; timezone?: string; providers?: string[]; enabled?: boolean; sourceId?: string }
  }>('/projects/:name/schedule', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const parsedBody = scheduleUpsertRequestSchema.safeParse(request.body)
    if (!parsedBody.success) {
      throw validationError('Invalid schedule payload', {
        issues: parsedBody.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }
    // Body kind takes precedence over the query string. Both default to
    // 'answer-visibility' so the legacy URL still works unchanged.
    const kind = parsedBody.data.kind ?? parseKindParam(request.query?.kind)
    const { preset, cron, timezone, providers, enabled, sourceId } = parsedBody.data

    // Per-kind invariants
    if (kind === SchedulableRunKinds['traffic-sync']) {
      if (!sourceId) {
        throw validationError('"sourceId" is required when kind is "traffic-sync"')
      }
      const sourceRow = app.db.select().from(trafficSources).where(eq(trafficSources.id, sourceId)).get()
      if (!sourceRow || sourceRow.projectId !== project.id) {
        throw notFound('Traffic source', sourceId)
      }
      if (providers && providers.length > 0) {
        throw validationError('"providers" is not valid for kind "traffic-sync"')
      }
    } else if (sourceId) {
      throw validationError(`"sourceId" is only valid when kind is "traffic-sync"`)
    }

    // Validate provider names against registered adapters
    const validNames = opts.validProviderNames ?? []
    if (validNames.length && providers?.length) {
      const invalid = providers.filter(p => !validNames.includes(p))
      if (invalid.length) {
        throw validationError(`Invalid provider(s): ${invalid.join(', ')}. Must be one of: ${validNames.join(', ')}`, {
          invalidProviders: invalid,
          validProviders: validNames,
        })
      }
    }

    if (!isValidTimezone(timezone)) {
      throw validationError(`Invalid timezone: ${timezone}`)
    }

    let cronExpr: string
    if (preset) {
      try {
        cronExpr = resolvePreset(preset)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        throw validationError(msg)
      }
    } else {
      cronExpr = cron!
      if (!validateCron(cronExpr)) {
        throw validationError(`Invalid cron expression: ${cronExpr}`)
      }
    }

    const now = new Date().toISOString()
    const enabledBool = enabled !== false
    const existing = app.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.projectId, project.id), eq(schedules.kind, kind)))
      .get()

    if (existing) {
      app.db.update(schedules).set({
        cronExpr,
        preset: preset ?? null,
        timezone,
        providers: (providers ?? []) as ProviderName[],
        sourceId: sourceId ?? null,
        enabled: enabledBool,
        updatedAt: now,
      }).where(eq(schedules.id, existing.id)).run()
    } else {
      app.db.insert(schedules).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        kind,
        cronExpr,
        preset: preset ?? null,
        timezone,
        enabled: enabledBool,
        providers: (providers ?? []) as ProviderName[],
        sourceId: sourceId ?? null,
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: existing ? 'schedule.updated' : 'schedule.created',
      entityType: 'schedule',
      diff: { kind, cronExpr, preset, timezone, providers, sourceId },
    })

    opts.onScheduleUpdated?.('upsert', project.id, kind)

    const schedule = app.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.projectId, project.id), eq(schedules.kind, kind)))
      .get()!
    return reply.status(existing ? 200 : 201).send(formatSchedule(schedule))
  })

  // GET /projects/:name/schedule[?kind=...] — get schedule(s).
  // Returns the single schedule matching the requested kind (default
  // 'answer-visibility'). The legacy callsite that didn't pass a kind keeps
  // working unchanged.
  app.get<{ Params: { name: string }; Querystring: { kind?: string } }>('/projects/:name/schedule', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const kind = parseKindParam(request.query?.kind)

    const schedule = app.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.projectId, project.id), eq(schedules.kind, kind)))
      .get()
    if (!schedule) {
      throw notFound('Schedule', `${request.params.name} (kind=${kind})`)
    }

    return reply.send(formatSchedule(schedule))
  })

  // DELETE /projects/:name/schedule[?kind=...] — remove schedule for kind.
  app.delete<{ Params: { name: string }; Querystring: { kind?: string } }>('/projects/:name/schedule', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const kind = parseKindParam(request.query?.kind)

    const schedule = app.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.projectId, project.id), eq(schedules.kind, kind)))
      .get()
    if (!schedule) {
      throw notFound('Schedule', `${request.params.name} (kind=${kind})`)
    }

    app.db.delete(schedules).where(eq(schedules.id, schedule.id)).run()

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'schedule.deleted',
      entityType: 'schedule',
      entityId: schedule.id,
      diff: { kind },
    })

    opts.onScheduleUpdated?.('delete', project.id, kind)

    return reply.status(204).send()
  })
}

function formatSchedule(row: typeof schedules.$inferSelect): ScheduleDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as SchedulableRunKind,
    cronExpr: row.cronExpr,
    preset: row.preset,
    timezone: row.timezone,
    enabled: row.enabled,
    providers: row.providers,
    sourceId: row.sourceId,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
