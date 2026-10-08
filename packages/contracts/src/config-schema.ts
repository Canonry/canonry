import { z } from 'zod'
import { calendarRecurrenceSchema } from './schedule.js'
import { providerModelsSchema, providerNameSchema, locationContextSchema, type LocationContext } from './provider.js'
import { notificationEventSchema } from './notification.js'
import {
  competitorAutoAliasModeInputSchema,
  findDuplicateLocationLabels,
  hasLocationLabel,
  PROJECT_QUALIFIED_ALIAS_LIMIT,
  PROJECT_QUALIFIED_ALIAS_MAX_LENGTH,
} from './project.js'
import { measurementConfigSchema, defaultMeasurementConfig } from './measurement.js'
import { providerDispatchModesSchema } from './provider-batch.js'
import { gbpNegativeReviewMaxStarsSchema } from './gbp.js'
import { competitorEntrySchema } from './competitor-aliases.js'
import { siteAuditPageBudgetSchema } from './technical-aeo.js'

export const configMetadataSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message: 'Name must be a lowercase slug (letters, numbers, hyphens)',
  }),
  labels: z.record(z.string(), z.string()).optional().default({}),
})

const configScheduleObjectSchema = z.object({
  preset: z.string().min(1).optional(),
  cron: z.string().min(1).optional(),
  recurrence: calendarRecurrenceSchema.optional(),
  timezone: z.string().optional().default('UTC'),
  providers: z.array(providerNameSchema).optional().default([]),
  /**
   * Whether the schedule fires. Omit to leave an existing schedule's state
   * alone — a schedule paused from the dashboard or the API stays paused
   * across an apply, so config-as-code does not silently resume billing work
   * someone deliberately stopped. A schedule created by this apply defaults
   * to enabled.
   */
  enabled: z.boolean().optional(),
})

function hasOneScheduleTiming(schedule: { preset?: string; cron?: string; recurrence?: unknown }): boolean {
  return [schedule.preset, schedule.cron, schedule.recurrence].filter(value => value !== undefined).length === 1
}

const oneScheduleTimingMessage = { message: 'Exactly one of "preset", "cron", or "recurrence" must be provided' }

export const configScheduleSchema = configScheduleObjectSchema
  .refine(hasOneScheduleTiming, oneScheduleTimingMessage)
  .optional()

export const configNotificationSchema = z.object({
  channel: z.literal('webhook'),
  url: z.string().url(),
  events: z.array(notificationEventSchema).min(1),
})

export const configGoogleSchema = z.object({
  gsc: z.object({
    propertyUrl: z.string(),
  }).optional(),
  syncSchedule: z.object({
    preset: z.string().optional(),
    cron: z.string().optional(),
  }).optional(),
}).optional()

const configQueryListSchema = z.array(z.string().min(1))

const configSpecShape = {
  displayName: z.string().min(1),
  canonicalDomain: z.string().min(1),
  ownedDomains: z.array(z.string().min(1)).optional().default([]),
  aliases: z.array(z.string().min(1)).optional().default([]),
  // No default on purpose: an apply that omits it keeps the project's stored
  // list, minus names that no longer qualify against this spec's `aliases`,
  // display name and competitors. Each entry must be an alias.
  qualifiedAliases: z.array(z.string().min(1).max(PROJECT_QUALIFIED_ALIAS_MAX_LENGTH))
    .max(PROJECT_QUALIFIED_ALIAS_LIMIT).optional(),
  country: z.string().length(2),
  language: z.string().min(2),
  queries: configQueryListSchema.optional(),
  keywords: configQueryListSchema.optional(),
  // Each entry is a bare domain or `{ domain, aliases }`. A bare domain (or an
  // object without `aliases`) keeps that competitor's stored aliases on apply;
  // `aliases` sets them exactly (`[]` clears). The domain set itself is still
  // replaced by this list.
  competitors: z.array(competitorEntrySchema).optional().default([]),
  providers: z.array(providerNameSchema).optional().default([]),
  providerModels: providerModelsSchema.optional().default({}),
  // No default on purpose: an apply that omits it leaves the project's stored
  // preference alone, the same rule as `queries`.
  providerDispatchModes: providerDispatchModesSchema.optional(),
  locations: z.array(locationContextSchema).optional().default([]),
  defaultLocation: z.string().optional(),
  measurement: measurementConfigSchema.optional().default(defaultMeasurementConfig),
  schedule: configScheduleSchema,
  notifications: z.array(configNotificationSchema).optional().default([]),
  google: configGoogleSchema,
  autoExtractBacklinks: z.boolean().optional().default(false),
  /** Highest star rating that counts as a negative Google review (1-4). Omitted means the default of 3. */
  negativeReviewMaxStars: gbpNegativeReviewMaxStarsSchema.optional(),
  /**
   * Site Health page budget for scans that set none (1-50,000); null means the
   * full site. Absent leaves the stored value alone, so a re-apply that never
   * mentions it cannot undo a budget set in the dashboard.
   */
  siteAuditMaxPages: siteAuditPageBudgetSchema.nullable().optional(),
  /**
   * Answer-derived competitor alias detection: `off`, `preview` (log only) or
   * `apply`. Absent leaves the stored mode alone; a new project starts in
   * `preview`.
   */
  competitorAutoAliases: competitorAutoAliasModeInputSchema,
}

/** The cross-field rules every config spec must meet, shared by the apply and export forms. */
function checkConfigSpec(
  spec: { queries?: string[]; keywords?: string[]; locations: LocationContext[]; defaultLocation?: string },
  ctx: z.RefinementCtx,
): void {
  if (spec.queries !== undefined && spec.keywords !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'Use spec.queries; spec.keywords is accepted only as a legacy alias when spec.queries is omitted',
      path: ['keywords'],
    })
  }

  const duplicateLabels = findDuplicateLocationLabels(spec.locations)
  if (duplicateLabels.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `Duplicate location labels are not allowed: ${duplicateLabels.join(', ')}`,
      path: ['locations'],
    })
  }

  if (!hasLocationLabel(spec.locations, spec.defaultLocation)) {
    ctx.addIssue({
      code: 'custom',
      message: `defaultLocation "${spec.defaultLocation}" must match a configured location label`,
      path: ['defaultLocation'],
    })
  }
}

export const configSpecSchema = z.object(configSpecShape).superRefine(checkConfigSpec)

export const projectConfigSchema = z.object({
  apiVersion: z.literal('canonry/v1'),
  kind: z.literal('Project'),
  metadata: configMetadataSchema,
  spec: configSpecSchema,
})

/**
 * The document `GET /projects/:name/export` sends: the parsed form of
 * {@link projectConfigSchema}, with every defaulted field written out, except
 * that export leaves `spec.providerModels` out while it is empty and
 * `spec.autoExtractBacklinks` out while it is false. `POST /apply` fills both
 * defaults back in when it reads the document. Export always writes
 * `spec.queries` (never the legacy `keywords`) and a schedule's `enabled`,
 * which apply reads as optional, so both are required here. The spec keeps
 * apply's cross-field checks.
 */
export const projectConfigExportSchema = projectConfigSchema.extend({
  spec: z.object({
    ...configSpecShape,
    queries: configQueryListSchema,
    providerModels: providerModelsSchema.optional(),
    schedule: configScheduleObjectSchema
      .extend({ enabled: z.boolean() })
      .refine(hasOneScheduleTiming, oneScheduleTimingMessage)
      .optional(),
    autoExtractBacklinks: z.boolean().optional(),
  }).superRefine(checkConfigSpec),
})

export function resolveConfigSpecQueries(spec: { queries?: string[]; keywords?: string[] }): string[] {
  return spec.queries ?? spec.keywords ?? []
}

export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type ProjectConfigExport = z.infer<typeof projectConfigExportSchema>
export type ConfigNotification = z.infer<typeof configNotificationSchema>
export type ConfigMetadata = z.infer<typeof configMetadataSchema>
export type ConfigSpec = z.infer<typeof configSpecSchema>
