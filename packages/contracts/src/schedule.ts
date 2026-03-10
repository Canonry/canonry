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
