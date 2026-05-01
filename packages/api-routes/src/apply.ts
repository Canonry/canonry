import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { projects, keywords, competitors, schedules, notifications, parseJsonColumn } from '@ainyc/canonry-db'
import { normalizeProjectDomain, projectConfigSchema, registrableDomain, validationError } from '@ainyc/canonry-contracts'
import { writeAuditLog } from './helpers.js'
import { resolvePreset, validateCron, isValidTimezone } from './schedule-utils.js'
import { resolveWebhookTarget } from './webhooks.js'

export interface ApplyRoutesOptions {
  onScheduleUpdated?: (action: 'upsert' | 'delete', projectId: string) => void
  onProjectUpserted?: (projectId: string, projectName: string) => void
  onGoogleConnectionPropertyUpdated?: (domain: string, connectionType: 'gsc' | 'ga4', propertyId: string) => void
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
}

export async function applyRoutes(app: FastifyInstance, opts?: ApplyRoutesOptions) {
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
        const urlCheck = await resolveWebhookTarget(notif.url ?? '')
        if (!urlCheck.ok) throw validationError(`Notification URL invalid: ${urlCheck.message}`)
      }
    }

    const now = new Date().toISOString()
    const name = config.metadata.name

    // All validation done — wrap all writes in a single transaction
    let projectId: string
    let scheduleAction: 'upsert' | 'delete' | null = null

    app.db.transaction((tx) => {
      // Upsert project
      const existing = tx.select().from(projects).where(eq(projects.name, name)).get()

      if (existing) {
        projectId = existing.id
        tx.update(projects).set({
          displayName: config.spec.displayName,
          canonicalDomain: config.spec.canonicalDomain,
          ownedDomains: JSON.stringify(config.spec.ownedDomains ?? []),
          country: config.spec.country,
          language: config.spec.language,
          labels: JSON.stringify(config.metadata.labels),
          providers: JSON.stringify(config.spec.providers ?? []),
          locations: JSON.stringify(config.spec.locations ?? []),
          defaultLocation: config.spec.defaultLocation ?? null,
          autoExtractBacklinks: config.spec.autoExtractBacklinks ? 1 : 0,
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
          ownedDomains: JSON.stringify(config.spec.ownedDomains ?? []),
          country: config.spec.country,
          language: config.spec.language,
          tags: '[]',
          labels: JSON.stringify(config.metadata.labels),
          providers: JSON.stringify(config.spec.providers ?? []),
          locations: JSON.stringify(config.spec.locations ?? []),
          defaultLocation: config.spec.defaultLocation ?? null,
          autoExtractBacklinks: config.spec.autoExtractBacklinks ? 1 : 0,
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

      // Replace keywords + competitors
      tx.delete(keywords).where(eq(keywords.projectId, projectId)).run()
      for (const kw of config.spec.keywords) {
        tx.insert(keywords).values({
          id: crypto.randomUUID(),
          projectId,
          keyword: kw,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId,
        actor: 'api',
        action: 'keywords.replaced',
        entityType: 'keyword',
        diff: { keywords: config.spec.keywords },
      })

      tx.delete(competitors).where(eq(competitors.projectId, projectId)).run()
      const normalizedCompetitors = normalizeCompetitorList(config.spec.competitors)
      for (const domain of normalizedCompetitors) {
        tx.insert(competitors).values({
          id: crypto.randomUUID(),
          projectId,
          domain,
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

      // Handle schedule
      if (resolvedSchedule) {
        const existingSched = tx.select().from(schedules).where(eq(schedules.projectId, projectId)).get()
        if (existingSched) {
          tx.update(schedules).set({
            cronExpr: resolvedSchedule.cronExpr,
            preset: resolvedSchedule.preset,
            timezone: resolvedSchedule.timezone,
            providers: JSON.stringify(config.spec.schedule?.providers ?? []),
            enabled: 1,
            updatedAt: now,
          }).where(eq(schedules.id, existingSched.id)).run()
        } else {
          tx.insert(schedules).values({
            id: crypto.randomUUID(),
            projectId,
            cronExpr: resolvedSchedule.cronExpr,
            preset: resolvedSchedule.preset,
            timezone: resolvedSchedule.timezone,
            enabled: 1,
            providers: JSON.stringify(config.spec.schedule?.providers ?? []),
            createdAt: now,
            updatedAt: now,
          }).run()
        }
        scheduleAction = 'upsert'
      } else if (deleteSchedule) {
        const existingSched = tx.select().from(schedules).where(eq(schedules.projectId, projectId)).get()
        if (existingSched) {
          tx.delete(schedules).where(eq(schedules.projectId, projectId)).run()
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
            config: JSON.stringify({ url: notif.url, events: notif.events }),
            webhookSecret: crypto.randomBytes(32).toString('hex'),
            enabled: 1,
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

    // Fire callbacks after transaction commits
    if (scheduleAction) {
      opts?.onScheduleUpdated?.(scheduleAction, projectId!)
    }
    if (!hasNotifications) {
      opts?.onProjectUpserted?.(projectId!, config.metadata.name)
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
      ownedDomains: parseJsonColumn<string[]>(project.ownedDomains, []),
      country: project.country,
      language: project.language,
      tags: parseJsonColumn<string[]>(project.tags, []),
      labels: parseJsonColumn<Record<string, string>>(project.labels, {}),
      providers: parseJsonColumn<string[]>(project.providers, []),
      locations: parseJsonColumn<unknown[]>(project.locations, []),
      defaultLocation: project.defaultLocation,
      autoExtractBacklinks: project.autoExtractBacklinks === 1,
      configSource: project.configSource,
      configRevision: project.configRevision,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })
  })
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
