import { z } from 'zod'
import { providerNameSchema } from './provider.js'

/**
 * Run kinds that can be scheduled by the project schedule system. Subset of
 * the broader `RunKinds` — only kinds that make sense as a recurring trigger.
 *
 * - `answer-visibility` — citation/mention sweep across configured providers (the original schedulable kind).
 * - `traffic-sync` — server-side traffic-source pull (Cloud Run today; future adapters slot in here too).
 * - `gbp-sync` — Google Business Profile performance + local-signal pull over the project's selected locations.
 * - `data-refresh` — refresh every connected data integration for the project (GSC, Bing, GA, GBP) in one trigger.
 */
export const schedulableRunKindSchema = z.enum(['answer-visibility', 'traffic-sync', 'gbp-sync', 'data-refresh'])
export type SchedulableRunKind = z.infer<typeof schedulableRunKindSchema>
export const SchedulableRunKinds = schedulableRunKindSchema.enum

// --- DTOs ---

export const scheduleDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Run kind dispatched when this schedule fires. Defaults to 'answer-visibility' for legacy rows. */
  kind: schedulableRunKindSchema,
  cronExpr: z.string(),
  preset: z.string().nullable().optional(),
  timezone: z.string().default('UTC'),
  enabled: z.boolean().default(true),
  providers: z.array(providerNameSchema).default([]),
  /** Traffic-source UUID for `kind === 'traffic-sync'` schedules. Null otherwise. */
  sourceId: z.string().nullable().optional(),
  lastRunAt: z.string().nullable().optional(),
  nextRunAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type ScheduleDto = z.infer<typeof scheduleDtoSchema>

export const scheduleUpsertRequestSchema = z.object({
  /** Run kind. Defaults to 'answer-visibility' so existing callers don't have to change. */
  kind: schedulableRunKindSchema.optional(),
  preset: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional().default('UTC'),
  enabled: z.boolean().optional().default(true),
  providers: z.array(providerNameSchema).optional().default([]),
  /** Required when kind === 'traffic-sync'. Forbidden for other kinds. Validated server-side. */
  sourceId: z.string().optional(),
}).refine(
  (data) => (data.preset && !data.cron) || (!data.preset && data.cron),
  { message: 'Exactly one of "preset" or "cron" must be provided' },
)

export type ScheduleUpsertRequest = z.infer<typeof scheduleUpsertRequestSchema>
