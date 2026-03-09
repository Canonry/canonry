import { z } from 'zod'

export const configMetadataSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message: 'Name must be a lowercase slug (letters, numbers, hyphens)',
  }),
  labels: z.record(z.string(), z.string()).optional().default({}),
})

export const configSpecSchema = z.object({
  displayName: z.string().min(1),
  canonicalDomain: z.string().min(1),
  country: z.string().length(2),
  language: z.string().min(2),
  keywords: z.array(z.string().min(1)).optional().default([]),
  competitors: z.array(z.string().min(1)).optional().default([]),
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
