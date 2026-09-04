import crypto from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schedules, trafficSources } from '@ainyc/canonry-db'
import {
  type ScheduleDto,
  type ProviderName,
  type SchedulableRunKind,
  SchedulableRunKinds,
  schedulableRunKindSchema,
  scheduleExpectedUpdatedAtSchema,
  scheduleUpsertRequestSchema,
  scheduleVersionConflict,
  validationError,
  notFound,
  describeError,
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

function parseExpectedUpdatedAtParam(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  const parsed = scheduleExpectedUpdatedAtSchema.safeParse(raw)
  if (!parsed.success) throw validationError('Invalid expectedUpdatedAt timestamp')
  return parsed.data
}

function nextScheduleUpdatedAt(previous: string | undefined): string {
  const previousMs = previous === undefined ? Number.NaN : Date.parse(previous)
  return new Date(Number.isFinite(previousMs)
    ? Math.max(Date.now(), previousMs + 1)
    : Date.now()).toISOString()
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
    Body: { kind?: string; preset?: string; cron?: string; timezone?: string; providers?: string[]; enabled?: boolean; sourceId?: string; expectedUpdatedAt?: string | null }
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
    const { preset, cron, timezone, providers, enabled, sourceId, expectedUpdatedAt } = parsedBody.data

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

    // backlinks-sync is workspace-global (re-probes Common Crawl): no providers.
    if (kind === SchedulableRunKinds['backlinks-sync'] && providers && providers.length > 0) {
      throw validationError('"providers" is not valid for kind "backlinks-sync"')
    }

    // site-audit (Technical AEO) crawls the sitemap — no answer-engine providers.
    if (kind === SchedulableRunKinds['site-audit'] && providers && providers.length > 0) {
      throw validationError('"providers" is not valid for kind "site-audit"')
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
        const msg = describeError(err)
        throw validationError(msg)
      }
    } else {
      cronExpr = cron!
      if (!validateCron(cronExpr)) {
        throw validationError(`Invalid cron expression: ${cronExpr}`)
      }
    }

    const enabledBool = enabled !== false
    const mutation = app.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(schedules)
        .where(and(eq(schedules.projectId, project.id), eq(schedules.kind, kind)))
        .get()
      const actualUpdatedAt = existing?.updatedAt ?? null
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== actualUpdatedAt) {
        throw scheduleVersionConflict(expectedUpdatedAt, actualUpdatedAt)
      }

      const now = nextScheduleUpdatedAt(existing?.updatedAt)
      const scheduleId = existing?.id ?? crypto.randomUUID()
      const values = {
        cronExpr,
        preset: preset ?? null,
        timezone,
        providers: (providers ?? []) as ProviderName[],
        sourceId: sourceId ?? null,
        enabled: enabledBool,
        updatedAt: now,
      }

      if (existing) {
        const changed = tx.update(schedules).set(values).where(
          expectedUpdatedAt === undefined
            ? eq(schedules.id, existing.id)
            : and(eq(schedules.id, existing.id), eq(schedules.updatedAt, expectedUpdatedAt ?? existing.updatedAt)),
        ).run()
        if (changed.changes !== 1) {
          const actual = tx.select().from(schedules).where(eq(schedules.id, existing.id)).get()
          throw scheduleVersionConflict(expectedUpdatedAt ?? existing.updatedAt, actual?.updatedAt ?? null)
        }
      } else {
        const insert = tx.insert(schedules).values({
          id: scheduleId,
          projectId: project.id,
          kind,
          ...values,
          createdAt: now,
        })
        const inserted = expectedUpdatedAt === null
          ? insert.onConflictDoNothing().run()
          : insert.run()
        if (expectedUpdatedAt === null && inserted.changes !== 1) {
          const actual = tx.select().from(schedules)
            .where(and(eq(schedules.projectId, project.id), eq(schedules.kind, kind))).get()
          throw scheduleVersionConflict(null, actual?.updatedAt ?? null)
        }
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: existing ? 'schedule.updated' : 'schedule.created',
        entityType: 'schedule',
        diff: { kind, cronExpr, preset, timezone, providers, sourceId },
      })

      return {
        existed: existing !== undefined,
      }
    })

    opts.onScheduleUpdated?.('upsert', project.id, kind)
    // The live scheduler recomputes nextRunAt and advances updatedAt inside
    // this callback. Return that authoritative version so a client can use the
    // response's updatedAt for its next compare-and-swap.
    const schedule = app.db.select().from(schedules)
      .where(and(eq(schedules.projectId, project.id), eq(schedules.kind, kind))).get()!
    return reply.status(mutation.existed ? 200 : 201).send(formatSchedule(schedule))
  })

  // GET /projects/:name/schedules — list every configured schedule.
  // An empty project returns [] rather than a 404 so discovery callers can
  // distinguish "none configured" without treating expected absence as a
  // failed resource load. The singular route below keeps its legacy contract.
  app.get<{ Params: { name: string } }>('/projects/:name/schedules', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db
      .select()
      .from(schedules)
      .where(eq(schedules.projectId, project.id))
      .orderBy(asc(schedules.kind))
      .all()

    return reply.send(rows.map(formatSchedule))
  })

  // GET /projects/:name/schedule[?kind=...] — get one schedule.
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
  app.delete<{ Params: { name: string }; Querystring: { kind?: string; expectedUpdatedAt?: string } }>('/projects/:name/schedule', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const kind = parseKindParam(request.query?.kind)
    const expectedUpdatedAt = parseExpectedUpdatedAtParam(request.query?.expectedUpdatedAt)

    app.db.transaction((tx) => {
      const schedule = tx.select().from(schedules)
        .where(and(eq(schedules.projectId, project.id), eq(schedules.kind, kind))).get()
      if (!schedule) {
        if (expectedUpdatedAt !== undefined) throw scheduleVersionConflict(expectedUpdatedAt, null)
        throw notFound('Schedule', `${request.params.name} (kind=${kind})`)
      }
      if (expectedUpdatedAt !== undefined && schedule.updatedAt !== expectedUpdatedAt) {
        throw scheduleVersionConflict(expectedUpdatedAt, schedule.updatedAt)
      }

      const deleted = tx.delete(schedules).where(
        expectedUpdatedAt === undefined
          ? eq(schedules.id, schedule.id)
          : and(eq(schedules.id, schedule.id), eq(schedules.updatedAt, expectedUpdatedAt)),
      ).run()
      if (deleted.changes !== 1) {
        const actual = tx.select().from(schedules).where(eq(schedules.id, schedule.id)).get()
        throw scheduleVersionConflict(expectedUpdatedAt ?? schedule.updatedAt, actual?.updatedAt ?? null)
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'schedule.deleted',
        entityType: 'schedule',
        entityId: schedule.id,
        diff: { kind },
      })
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
