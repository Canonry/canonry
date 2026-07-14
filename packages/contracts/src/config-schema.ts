import { z } from 'zod'
import { providerModelsSchema, providerNameSchema, locationContextSchema } from './provider.js'
import { notificationEventSchema } from './notification.js'
import { findDuplicateLocationLabels, hasLocationLabel } from './project.js'

export const configMetadataSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message: 'Name must be a lowercase slug (letters, numbers, hyphens)',
  }),
  labels: z.record(z.string(), z.string()).optional().default({}),
})

export const configScheduleSchema = z.object({
  preset: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional().default('UTC'),
  providers: z.array(providerNameSchema).optional().default([]),
}).refine(
  (data) => (data.preset && !data.cron) || (!data.preset && data.cron),
  { message: 'Exactly one of "preset" or "cron" must be provided' },
).optional()

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

export const configSpecSchema = z.object({
  displayName: z.string().min(1),
  canonicalDomain: z.string().min(1),
  ownedDomains: z.array(z.string().min(1)).optional().default([]),
  aliases: z.array(z.string().min(1)).optional().default([]),
  country: z.string().length(2),
  language: z.string().min(2),
  queries: configQueryListSchema.optional(),
  keywords: configQueryListSchema.optional(),
  competitors: z.array(z.string().min(1)).optional().default([]),
  providers: z.array(providerNameSchema).optional().default([]),
  providerModels: providerModelsSchema.optional().default({}),
  locations: z.array(locationContextSchema).optional().default([]),
  defaultLocation: z.string().optional(),
  schedule: configScheduleSchema,
  notifications: z.array(configNotificationSchema).optional().default([]),
  google: configGoogleSchema,
  autoExtractBacklinks: z.boolean().optional().default(false),
}).superRefine((spec, ctx) => {
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
})

export const projectConfigSchema = z.object({
  apiVersion: z.literal('canonry/v1'),
  kind: z.literal('Project'),
  metadata: configMetadataSchema,
  spec: configSpecSchema,
})

export function resolveConfigSpecQueries(spec: { queries?: string[]; keywords?: string[] }): string[] {
  return spec.queries ?? spec.keywords ?? []
}

export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type ConfigMetadata = z.infer<typeof configMetadataSchema>
export type ConfigSpec = z.infer<typeof configSpecSchema>
