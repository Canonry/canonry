import { z } from 'zod'
import { calendarRecurrenceSchema } from './schedule.js'
import { locationContextSchema, providerModelsSchema } from './provider.js'
import { providerDispatchModesSchema } from './provider-batch.js'
import { configSourceSchema } from './project.js'
import { measurementConfigSchema } from './measurement.js'

function fieldChangeSchema<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ before: schema.nullable(), after: schema.nullable() })
}

const projectFieldsStateSchema = z.object({
  displayName: z.string().optional(),
  canonicalDomain: z.string().optional(),
  ownedDomains: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  qualifiedAliases: z.array(z.string()).optional(),
  country: z.string().optional(),
  language: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  providers: z.array(z.string()).optional(),
  providerModels: providerModelsSchema.optional(),
  providerDispatchModes: providerDispatchModesSchema.optional(),
  'measurement.marketingHosts': measurementConfigSchema.shape.marketingHosts.optional(),
  'measurement.brandTerms': measurementConfigSchema.shape.brandTerms.optional(),
  'measurement.leadEventNames': measurementConfigSchema.shape.leadEventNames.optional(),
  'measurement.countKeyEvents': z.boolean().optional(),
  locations: z.array(locationContextSchema).optional(),
  defaultLocation: z.string().nullable().optional(),
  autoExtractBacklinks: z.boolean().optional(),
  negativeReviewMaxStars: z.number().int().nullable().optional(),
  siteAuditMaxPages: z.number().int().nullable().optional(),
  competitorAutoAliases: z.enum(['off', 'preview', 'apply']).optional(),
  configSource: configSourceSchema.optional(),
}).strict()

const projectFieldsChangeSchema = z.object({
  displayName: fieldChangeSchema(z.string()).optional(),
  canonicalDomain: fieldChangeSchema(z.string()).optional(),
  ownedDomains: fieldChangeSchema(z.array(z.string())).optional(),
  aliases: fieldChangeSchema(z.array(z.string())).optional(),
  qualifiedAliases: fieldChangeSchema(z.array(z.string())).optional(),
  country: fieldChangeSchema(z.string()).optional(),
  language: fieldChangeSchema(z.string()).optional(),
  labels: fieldChangeSchema(z.record(z.string(), z.string())).optional(),
  providers: fieldChangeSchema(z.array(z.string())).optional(),
  providerModels: fieldChangeSchema(providerModelsSchema).optional(),
  providerDispatchModes: fieldChangeSchema(providerDispatchModesSchema).optional(),
  'measurement.marketingHosts': fieldChangeSchema(measurementConfigSchema.shape.marketingHosts).optional(),
  'measurement.brandTerms': fieldChangeSchema(measurementConfigSchema.shape.brandTerms).optional(),
  'measurement.leadEventNames': fieldChangeSchema(measurementConfigSchema.shape.leadEventNames).optional(),
  'measurement.countKeyEvents': fieldChangeSchema(z.boolean()).optional(),
  locations: fieldChangeSchema(z.array(locationContextSchema)).optional(),
  defaultLocation: fieldChangeSchema(z.string()).optional(),
  autoExtractBacklinks: fieldChangeSchema(z.boolean()).optional(),
  negativeReviewMaxStars: fieldChangeSchema(z.number().int()).optional(),
  siteAuditMaxPages: fieldChangeSchema(z.number().int().nullable()).optional(),
  competitorAutoAliases: fieldChangeSchema(z.enum(['off', 'preview', 'apply'])).optional(),
  configSource: fieldChangeSchema(configSourceSchema).optional(),
}).strict()

const scheduleStateSchema = z.object({
  cron: z.string().optional(),
  preset: z.string().optional(),
  recurrence: calendarRecurrenceSchema.optional(),
  timezone: z.string(),
  providers: z.array(z.string()),
  enabled: z.boolean(),
}).strict()

const droppedAliasSchema = z.object({
  domain: z.string(),
  alias: z.string(),
  reason: z.enum(['too-long', 'too-short', 'project-brand', 'other-competitor', 'market-competitor', 'claimed-by-alias']),
  conflictsWith: z.string().optional(),
  conflictingName: z.string().optional(),
  markets: z.array(z.string()).optional(),
}).strict()

const configStateNotificationSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  urlHost: z.string(),
  events: z.array(z.string()),
  enabled: z.boolean(),
  source: z.string().optional(),
})

export const projectConfigStateSchema = z.object({
  project: z.object({ id: z.string(), name: z.string() }),
  configRevision: z.number().int(),
  fields: projectFieldsStateSchema,
  queries: z.array(z.object({ id: z.string(), text: z.string() })),
  competitors: z.array(z.object({ id: z.string(), domain: z.string(), aliases: z.array(z.string()) })),
  schedule: scheduleStateSchema.nullable(),
  notifications: z.array(configStateNotificationSchema),
  managed: z.object({ queries: z.boolean(), competitors: z.boolean(), schedule: z.boolean(), notifications: z.boolean() }),
  detachedSnapshotCount: z.number().int().nonnegative(),
})

export type ProjectConfigState = z.infer<typeof projectConfigStateSchema>

const notificationAddedSchema = z.object({ urlHost: z.string(), events: z.array(z.string()) })
const notificationRemovedSchema = notificationAddedSchema.extend({ id: z.string() })
const notificationKeptSchema = z.object({
  id: z.string(),
  urlHost: z.string(),
  urlChanged: z.boolean(),
  eventsBefore: z.array(z.string()),
  eventsAfter: z.array(z.string()),
})

export const applyPreviewDtoSchema = z.object({
  project: z.object({ id: z.string().nullable(), name: z.string() }),
  action: z.enum(['create', 'update', 'none']),
  changed: z.boolean(),
  configRevision: z.object({ before: z.number().int().nullable(), after: z.number().int() }),
  fields: projectFieldsChangeSchema,
  queries: z.object({
    managed: z.boolean(),
    added: z.array(z.string()),
    removed: z.array(z.string()),
    unchangedCount: z.number().int().nonnegative(),
    snapshotsDetached: z.number().int().nonnegative(),
  }),
  competitors: z.object({
    managed: z.boolean(),
    added: z.array(z.string()),
    removed: z.array(z.string()),
    aliasChanges: z.array(z.object({ domain: z.string(), before: z.array(z.string()), after: z.array(z.string()) })),
    droppedAliases: z.array(droppedAliasSchema),
  }),
  schedule: z.object({
    managed: z.boolean(),
    action: z.enum(['create', 'update', 'delete', 'none']),
    before: scheduleStateSchema.nullable(),
    after: scheduleStateSchema.nullable(),
  }),
  notifications: z.object({
    managed: z.boolean(),
    added: z.array(notificationAddedSchema),
    removed: z.array(notificationRemovedSchema),
    kept: z.array(notificationKeptSchema),
    secretsRotated: z.number().int().nonnegative(),
  }),
  effects: z.array(z.enum([
    'mention-backfill',
    'competitor-rescore',
    'competitor-auto-alias-rescan',
    'schedule-reload',
    'gsc-property-update',
  ])),
})

export type ApplyPreviewDto = z.infer<typeof applyPreviewDtoSchema>

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function queryDiff(before: ProjectConfigState | null, after: ProjectConfigState): ApplyPreviewDto['queries'] {
  if (!after.managed.queries) {
    return { managed: false, added: [], removed: [], unchangedCount: 0, snapshotsDetached: 0 }
  }
  const beforeByKey = new Map((before?.queries ?? []).map(query => [query.text.trim().toLowerCase(), query.text]))
  const afterByKey = new Map(after.queries.map(query => [query.text.trim().toLowerCase(), query.text]))
  return {
    managed: true,
    added: [...afterByKey.entries()].filter(([key]) => !beforeByKey.has(key)).map(([, text]) => text),
    removed: [...beforeByKey.entries()].filter(([key]) => !afterByKey.has(key)).map(([, text]) => text),
    unchangedCount: [...afterByKey.keys()].filter(key => beforeByKey.has(key)).length,
    snapshotsDetached: Math.max(0, after.detachedSnapshotCount - (before?.detachedSnapshotCount ?? 0)),
  }
}

function competitorDiff(before: ProjectConfigState | null, after: ProjectConfigState, droppedAliases: ApplyPreviewDto['competitors']['droppedAliases']): ApplyPreviewDto['competitors'] {
  const beforeByDomain = new Map((before?.competitors ?? []).map(row => [row.domain, row]))
  const afterByDomain = new Map(after.competitors.map(row => [row.domain, row]))
  const aliasChanges: ApplyPreviewDto['competitors']['aliasChanges'] = []
  for (const [domain, row] of afterByDomain) {
    const previous = beforeByDomain.get(domain)
    if (previous && !sameValue(previous.aliases, row.aliases)) {
      aliasChanges.push({ domain, before: previous.aliases, after: row.aliases })
    }
  }
  return {
    managed: after.managed.competitors,
    added: [...afterByDomain.entries()].filter(([domain]) => !beforeByDomain.has(domain)).map(([, row]) => row.domain),
    removed: [...beforeByDomain.entries()].filter(([domain]) => !afterByDomain.has(domain)).map(([, row]) => row.domain),
    aliasChanges,
    droppedAliases,
  }
}

function scheduleDiff(before: ProjectConfigState | null, after: ProjectConfigState): ApplyPreviewDto['schedule'] {
  const previous = before?.schedule ?? null
  const next = after.schedule ?? null
  let action: ApplyPreviewDto['schedule']['action'] = 'none'
  if (previous === null && next !== null) action = 'create'
  else if (previous !== null && next === null) action = 'delete'
  else if (!sameValue(previous, next)) action = 'update'
  return { managed: after.managed.schedule, action, before: previous, after: next }
}

function notificationDiff(before: ProjectConfigState | null, after: ProjectConfigState): ApplyPreviewDto['notifications'] {
  if (!after.managed.notifications) {
    return { managed: false, added: [], removed: [], kept: [], secretsRotated: 0 }
  }
  const beforeById = new Map((before?.notifications ?? []).map(row => [row.id, row]))
  const afterById = new Map(after.notifications.map(row => [row.id, row]))
  const kept: ApplyPreviewDto['notifications']['kept'] = []
  for (const [id, row] of afterById) {
    const previous = beforeById.get(id)
    if (previous && (!sameValue(previous.events, row.events) || !sameValue(previous.url, row.url))) {
      kept.push({
        id,
        urlHost: row.urlHost,
        urlChanged: !sameValue(previous.url, row.url),
        eventsBefore: previous.events,
        eventsAfter: row.events,
      })
    }
  }
  return {
    managed: true,
    added: [...afterById.entries()].filter(([id]) => !beforeById.has(id)).map(([, row]) => ({ urlHost: row.urlHost, events: row.events })),
    removed: [...beforeById.entries()].filter(([id]) => !afterById.has(id)).map(([id, row]) => ({ id, urlHost: row.urlHost, events: row.events })),
    kept,
    secretsRotated: [...afterById.keys()].filter(id => !beforeById.has(id)).length,
  }
}

export interface ConfigDiffOptions {
  droppedAliases?: ApplyPreviewDto['competitors']['droppedAliases']
  effects?: ApplyPreviewDto['effects']
}

export function diffProjectConfigState(before: ProjectConfigState | null, after: ProjectConfigState, options: ConfigDiffOptions = {}): ApplyPreviewDto {
  const fields: Record<string, { before: unknown; after: unknown }> = {}
  const fieldNames = new Set<keyof ProjectConfigState['fields']>([
    ...Object.keys(before?.fields ?? {}) as (keyof ProjectConfigState['fields'])[],
    ...Object.keys(after.fields) as (keyof ProjectConfigState['fields'])[],
  ])
  for (const field of fieldNames) {
    const previous = before?.fields[field] ?? null
    const next = after.fields[field] ?? null
    if (!sameValue(previous, next)) fields[field] = { before: previous, after: next }
  }
  const queries = queryDiff(before, after)
  const competitors = competitorDiff(before, after, options.droppedAliases ?? [])
  const schedule = scheduleDiff(before, after)
  const notifications = notificationDiff(before, after)
  const effects: ApplyPreviewDto['effects'] = []
  if (options.effects) effects.push(...options.effects)
  const changed = Object.keys(fields).length > 0
    || queries.added.length > 0 || queries.removed.length > 0 || competitors.added.length > 0
    || competitors.removed.length > 0 || competitors.aliasChanges.length > 0 || competitors.droppedAliases.length > 0 || schedule.action !== 'none'
    || notifications.added.length > 0 || notifications.removed.length > 0 || notifications.kept.length > 0
    || queries.snapshotsDetached > 0
  return {
    project: { id: before?.project.id ?? null, name: after.project.name },
    action: before ? (changed ? 'update' : 'none') : 'create',
    changed,
    configRevision: { before: before?.configRevision ?? null, after: after.configRevision },
    fields: fields as ApplyPreviewDto['fields'],
    queries,
    competitors,
    schedule,
    notifications,
    effects,
  }
}
