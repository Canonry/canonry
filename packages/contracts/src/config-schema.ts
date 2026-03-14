import { z } from 'zod'
import { providerNameSchema } from './provider.js'
import { notificationEventSchema } from './notification.js'

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

export const configSpecSchema = z.object({
  displayName: z.string().min(1),
  canonicalDomain: z.string().min(1),
  ownedDomains: z.array(z.string().min(1)).optional().default([]),
  country: z.string().length(2),
  language: z.string().min(2),
  keywords: z.array(z.string().min(1)).optional().default([]),
  competitors: z.array(z.string().min(1)).optional().default([]),
  providers: z.array(providerNameSchema).optional().default([]),
  schedule: configScheduleSchema,
  notifications: z.array(configNotificationSchema).optional().default([]),
})

export const projectConfigSchema = z.object({
  apiVersion: z.literal('canonry/v1'),
  kind: z.literal('Project'),
  metadata: configMetadataSchema,
  spec: configSpecSchema,
})

export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type ConfigMetadata = z.infer<typeof configMetadataSchema>
export type ConfigSpec = z.infer<typeof configSpecSchema>
