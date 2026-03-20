import { z } from 'zod'
import { providerNameSchema } from './provider.js'

// --- DTOs ---

export const scheduleDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  cronExpr: z.string(),
  preset: z.string().nullable().optional(),
  timezone: z.string().default('UTC'),
  enabled: z.boolean().default(true),
  providers: z.array(providerNameSchema).default([]),
  lastRunAt: z.string().nullable().optional(),
  nextRunAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type ScheduleDto = z.infer<typeof scheduleDtoSchema>

export const scheduleUpsertRequestSchema = z.object({
  preset: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional().default('UTC'),
  enabled: z.boolean().optional().default(true),
  providers: z.array(providerNameSchema).optional().default([]),
}).refine(
  (data) => (data.preset && !data.cron) || (!data.preset && data.cron),
  { message: 'Exactly one of "preset" or "cron" must be provided' },
)

export type ScheduleUpsertRequest = z.infer<typeof scheduleUpsertRequestSchema>
