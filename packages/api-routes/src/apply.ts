import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { projects, queries, competitors, schedules, notifications } from '@ainyc/canonry-db'
import { forbidden, normalizeProjectAliases, normalizeProjectDomain, projectConfigSchema, registrableDomain, resolveConfigSpecQueries, SchedulableRunKinds, validationError } from '@ainyc/canonry-contracts'
import { writeAuditLog } from './helpers.js'
import { resolvePreset, validateCron, isValidTimezone } from './schedule-utils.js'
import { resolveWebhookTarget } from './webhooks.js'

export interface ApplyRoutesOptions {
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string, kind: import('@ainyc/canonry-contracts').SchedulableRunKind) => void
  onProjectUpserted?: (projectId: string, projectName: string) => void
  /** See `ProjectRoutesOptions.onAliasesChanged`. */
  onAliasesChanged?: (projectId: string, projectName: string) => void
  onGoogleConnectionPropertyUpdated?: (domain: string, connectionType: 'gsc' | 'ga4', propertyId: string) => void
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
  /** Allow webhook URLs that resolve to loopback addresses. Defaults to false. */
  allowLoopbackWebhooks?: boolean
}

export async function applyRoutes(app: FastifyInstance, opts?: ApplyRoutesOptions) {
  const allowLoopback = opts?.allowLoopbackWebhooks === true
  // POST /apply — accept a canonry.yaml body (JSON-parsed version)
  app.post('/apply', async (request, reply) => {
    const parsed = projectConfigSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid project config', {
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    const config = parsed.data

    // Validate provider names against registered adapters
    const validNames = opts?.validProviderNames ?? []
    if (validNames.length) {
      const allProviders = [
        ...(config.spec.providers ?? []),
        ...(config.spec.schedule?.providers ?? []),
      ]
      if (allProviders.length) {
        const invalid = allProviders.filter(p => !validNames.includes(p))
        if (invalid.length) {
          throw validationError(`Invalid provider(s): ${[...new Set(invalid)].join(', ')}. Must be one of: ${validNames.join(', ')}`, {
            invalidProviders: [...new Set(invalid)],
            validProviders: validNames,
          })
        }
      }
    }

    // Validate schedule before entering transaction
    let resolvedSchedule: { cronExpr: string; preset: string | null; timezone: string } | null = null
    let deleteSchedule = false
    if (config.spec.schedule) {
      const schedSpec = config.spec.schedule
      let cronExpr: string
      let preset: string | null = null

      if (schedSpec.preset) {
        preset = schedSpec.preset
        try {
          cronExpr = resolvePreset(schedSpec.preset)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          throw validationError(msg)
        }
      } else if (schedSpec.cron) {
        cronExpr = schedSpec.cron
        if (!validateCron(cronExpr)) throw validationError(`Invalid cron expression in schedule: ${cronExpr}`)
      } else {
        throw validationError('Schedule requires either "preset" or "cron"')
      }

      const timezone = schedSpec.timezone ?? 'UTC'
      if (!isValidTimezone(timezone)) throw validationError(`Invalid timezone: ${timezone}`)

      resolvedSchedule = { cronExpr, preset, timezone }
    } else {
      deleteSchedule = true
    }

    // Validate webhook URLs before entering transaction (async I/O)
    const rawSpec = (request.body as { spec?: Record<string, unknown> })?.spec ?? {}
    const hasNotifications = 'notifications' in rawSpec
    if (hasNotifications) {
      for (const notif of config.spec.notifications) {
        const urlCheck = await resolveWebhookTarget(notif.url ?? '', { allowLoopback })
        if (!urlCheck.ok) throw validationError(`Notification URL invalid: ${urlCheck.message}`)
      }
    }

    const now = new Date().toISOString()
    const name = config.metadata.name
    const configQueries = resolveConfigSpecQueries(config.spec)

    // A project-scoped key may only apply to ITS OWN project — never create a
    // new project or overwrite a sibling. The target must already exist and
    // resolve to the key's project (this global route is not under the
    // /projects/:name auth gate).
    const scopedProjectId = request.apiKey?.projectId
    if (scopedProjectId) {
      const target = app.db.select({ id: projects.id }).from(projects).where(eq(projects.name, name)).get()
      if (!target || target.id !== scopedProjectId) {
        throw forbidden('This API key is scoped to a single project and cannot apply this config.')
      }
    }

    // All validation done — wrap all writes in a single transaction
    let projectId: string
    let scheduleAction: 'upsert' | 'delete' | null = null
    let aliasesChanged = false

    app.db.transaction((tx) => {
      // Upsert project
      const existing = tx.select().from(projects).where(eq(projects.name, name)).get()

      const nextAliases = normalizeProjectAliases(config.spec.displayName, config.spec.aliases ?? [])
      // Only fire on actual changes to an existing project — a brand-new project
      // has no historical snapshots to backfill.
      if (existing) {
        const prevAliases = existing.aliases
        aliasesChanged = !aliasArraysEqual(prevAliases, nextAliases)
      }

      if (existing) {
        projectId = existing.id
        tx.update(projects).set({
          displayName: config.spec.displayName,
          canonicalDomain: config.spec.canonicalDomain,
          ownedDomains: config.spec.ownedDomains ?? [],
          aliases: nextAliases,
          country: config.spec.country,
          language: config.spec.language,
          labels: config.metadata.labels,
          providers: config.spec.providers ?? [],
          locations: config.spec.locations ?? [],
          defaultLocation: config.spec.defaultLocation ?? null,
          autoExtractBacklinks: config.spec.autoExtractBacklinks ?? false,
          configSource: 'config-file',
          configRevision: existing.configRevision + 1,
          updatedAt: now,
        }).where(eq(projects.id, existing.id)).run()

        writeAuditLog(tx, {
          projectId,
          actor: 'api',
          action: 'project.applied',
          entityType: 'project',
          entityId: projectId,
        })
      } else {
        projectId = crypto.randomUUID()
        tx.insert(projects).values({
          id: projectId,
          name,
          displayName: config.spec.displayName,
          canonicalDomain: config.spec.canonicalDomain,
          ownedDomains: config.spec.ownedDomains ?? [],
          aliases: nextAliases,
          country: config.spec.country,
          language: config.spec.language,
          tags: [],
          labels: config.metadata.labels,
          providers: config.spec.providers ?? [],
          locations: config.spec.locations ?? [],
          defaultLocation: config.spec.defaultLocation ?? null,
          autoExtractBacklinks: config.spec.autoExtractBacklinks ?? false,
          configSource: 'config-file',
          configRevision: 1,
          createdAt: now,
          updatedAt: now,
        }).run()

        writeAuditLog(tx, {
          projectId,
          actor: 'api',
          action: 'project.created',
          entityType: 'project',
          entityId: projectId,
        })
      }

      // Replace queries + competitors
      tx.delete(queries).where(eq(queries.projectId, projectId)).run()
      for (const q of configQueries) {
        tx.insert(queries).values({
          id: crypto.randomUUID(),
          projectId,
          query: q,
          provenance: 'cli',
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId,
        actor: 'api',
        action: 'queries.replaced',
        entityType: 'query',
        diff: { queries: configQueries },
      })

      tx.delete(competitors).where(eq(competitors.projectId, projectId)).run()
      const normalizedCompetitors = normalizeCompetitorList(config.spec.competitors)
      for (const domain of normalizedCompetitors) {
        tx.insert(competitors).values({
          id: crypto.randomUUID(),
          projectId,
          domain,
          provenance: 'cli',
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId,
        actor: 'api',
        action: 'competitors.replaced',
        entityType: 'competitor',
        diff: { competitors: normalizedCompetitors },
      })

      // Handle schedule. `canonry apply` only manages the answer-visibility
      // schedule — traffic-sync schedules have no surface in the YAML config-
      // as-code spec, so every schedules query in this block must be scoped
      // to kind='answer-visibility' or it will silently destroy / corrupt
      // the user's traffic-sync schedule on the same project.
      const AV_KIND = SchedulableRunKinds['answer-visibility']
      if (resolvedSchedule) {
        const existingSched = tx
          .select()
          .from(schedules)
          .where(and(eq(schedules.projectId, projectId), eq(schedules.kind, AV_KIND)))
          .get()
        if (existingSched) {
          tx.update(schedules).set({
            cronExpr: resolvedSchedule.cronExpr,
            preset: resolvedSchedule.preset,
            timezone: resolvedSchedule.timezone,
            providers: config.spec.schedule?.providers ?? [],
            enabled: true,
            updatedAt: now,
          }).where(eq(schedules.id, existingSched.id)).run()
        } else {
          tx.insert(schedules).values({
            id: crypto.randomUUID(),
            projectId,
            kind: AV_KIND,
            cronExpr: resolvedSchedule.cronExpr,
            preset: resolvedSchedule.preset,
            timezone: resolvedSchedule.timezone,
            enabled: true,
            providers: config.spec.schedule?.providers ?? [],
            createdAt: now,
            updatedAt: now,
          }).run()
        }
        scheduleAction = 'upsert'
      } else if (deleteSchedule) {
        const existingSched = tx
          .select()
          .from(schedules)
          .where(and(eq(schedules.projectId, projectId), eq(schedules.kind, AV_KIND)))
          .get()
        if (existingSched) {
          tx.delete(schedules)
            .where(and(eq(schedules.projectId, projectId), eq(schedules.kind, AV_KIND)))
            .run()
          scheduleAction = 'delete'
        }
      }

      // Handle notifications
      if (hasNotifications) {
        tx.delete(notifications).where(eq(notifications.projectId, projectId)).run()
        for (const notif of config.spec.notifications) {
          tx.insert(notifications).values({
            id: crypto.randomUUID(),
            projectId,
            channel: notif.channel,
            config: { url: notif.url, events: notif.events },
            webhookSecret: crypto.randomBytes(32).toString('hex'),
            enabled: true,
            createdAt: now,
            updatedAt: now,
          }).run()
        }

        writeAuditLog(tx, {
          projectId,
          actor: 'api',
          action: 'notifications.replaced',
          entityType: 'notification',
          diff: { notifications: config.spec.notifications },
        })
      }
    })

    // Fire callbacks after transaction commits.
    if (scheduleAction) {
      opts?.onScheduleUpdated?.(scheduleAction, projectId!, SchedulableRunKinds['answer-visibility'])
    }
    if (!hasNotifications) {
      opts?.onProjectUpserted?.(projectId!, config.metadata.name)
    }
    if (aliasesChanged) {
      opts?.onAliasesChanged?.(projectId!, config.metadata.name)
    }
    if ('google' in rawSpec && config.spec.google?.gsc?.propertyUrl) {
      opts?.onGoogleConnectionPropertyUpdated?.(config.spec.canonicalDomain, 'gsc', config.spec.google.gsc.propertyUrl)
    }

    const project = app.db.select().from(projects).where(eq(projects.id, projectId!)).get()!
    return reply.status(200).send({
      id: project.id,
      name: project.name,
      displayName: project.displayName,
      canonicalDomain: project.canonicalDomain,
      ownedDomains: project.ownedDomains,
      aliases: project.aliases,
      country: project.country,
      language: project.language,
      tags: project.tags,
      labels: project.labels,
      providers: project.providers,
      locations: project.locations,
      defaultLocation: project.defaultLocation,
      autoExtractBacklinks: project.autoExtractBacklinks,
      configSource: project.configSource,
      configRevision: project.configRevision,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })
  })
}

// Case-insensitive value compare. Aliases are persisted post-normalize
// (trimmed, deduped, stable order); two sets that differ only in casing
// produce identical mention-detection output, so a casing rename does not
// need a backfill.
function aliasArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.toLowerCase() !== b[i]!.toLowerCase()) return false
  }
  return true
}

// Reduce competitor domains to their registrable form (eTLD+1) and dedupe.
// Mirrors the helper in `competitors.ts` so both the YAML apply path and the
// REST endpoints store competitors uniformly without subdomain noise.
function normalizeCompetitorList(domains: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of domains) {
    const trimmed = raw?.trim()
    if (!trimmed) continue
    const normalized = registrableDomain(trimmed) || normalizeProjectDomain(trimmed)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}
