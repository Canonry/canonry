import { and, eq, isNull } from 'drizzle-orm'
import { competitors, notifications, projects, queries, querySnapshots, runs, schedules, readNegativeReviewMaxStars, type DatabaseClient } from '@ainyc/canonry-db'
import { redactNotificationUrl } from './notification-redaction.js'
import { SchedulableRunKinds, type ProjectConfigState } from '@ainyc/canonry-contracts'

export interface ProjectConfigStateOptions {
  managed?: Partial<ProjectConfigState['managed']>
}

export function readProjectConfigState(
  db: Pick<DatabaseClient, 'select'>,
  name: string,
  options: ProjectConfigStateOptions = {},
): ProjectConfigState | null {
  const project = db.select().from(projects).where(eq(projects.name, name)).get()
  if (!project) return null
  const managed = {
    queries: options.managed?.queries ?? true,
    competitors: options.managed?.competitors ?? true,
    schedule: options.managed?.schedule ?? true,
    notifications: options.managed?.notifications ?? true,
  }
  const projectQueries = db.select({ id: queries.id, text: queries.query }).from(queries).where(eq(queries.projectId, project.id)).all()
  const projectCompetitors = db.select({ id: competitors.id, domain: competitors.domain, aliases: competitors.aliases })
    .from(competitors).where(eq(competitors.projectId, project.id)).all()
  const schedule = db.select().from(schedules).where(and(
    eq(schedules.projectId, project.id),
    eq(schedules.kind, SchedulableRunKinds['answer-visibility']),
  )).get()
  const projectNotifications = db.select().from(notifications).where(eq(notifications.projectId, project.id)).all()
  const detachedSnapshotCount = db.select({ id: querySnapshots.id })
    .from(querySnapshots)
    .innerJoin(runs, eq(querySnapshots.runId, runs.id))
    .where(and(eq(runs.projectId, project.id), isNull(querySnapshots.queryId)))
    .all().length

  return {
    project: { id: project.id, name: project.name },
    configRevision: project.configRevision,
    fields: {
      displayName: project.displayName,
      canonicalDomain: project.canonicalDomain,
      ownedDomains: project.ownedDomains,
      aliases: project.aliases,
      qualifiedAliases: project.qualifiedAliases,
      country: project.country,
      language: project.language,
      labels: project.labels,
      providers: project.providers,
      providerModels: project.providerModels,
      providerDispatchModes: project.providerDispatchModes,
      'measurement.marketingHosts': project.measurement.marketingHosts,
      'measurement.brandTerms': project.measurement.brandTerms,
      'measurement.leadEventNames': project.measurement.leadEventNames,
      locations: project.locations,
      defaultLocation: project.defaultLocation,
      autoExtractBacklinks: project.autoExtractBacklinks,
      negativeReviewMaxStars: readNegativeReviewMaxStars(db, project.id),
      siteAuditMaxPages: project.siteAuditMaxPages,
      competitorAutoAliases: project.competitorAutoAliases,
      configSource: project.configSource,
    },
    queries: projectQueries,
    competitors: projectCompetitors,
    schedule: schedule ? {
      ...(schedule.recurrence ? { recurrence: schedule.recurrence } : schedule.preset ? { preset: schedule.preset } : { cron: schedule.cronExpr }),
      timezone: schedule.timezone,
      providers: schedule.providers,
      enabled: schedule.enabled,
    } : null,
    notifications: projectNotifications.map(row => {
      const redacted = redactNotificationUrl(row.config.url)
      return {
        id: row.id,
        url: row.config.url,
        urlHost: redacted.urlHost,
        events: row.config.events,
        enabled: row.enabled,
        ...(row.config.source !== undefined ? { source: row.config.source } : {}),
      }
    }),
    managed,
    detachedSnapshotCount,
  }
}
