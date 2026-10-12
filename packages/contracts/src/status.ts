import { z } from 'zod'
import { runKindSchema, runStatusSchema, runTriggerSchema } from './run.js'

export const statusIntegrationSchema = z.enum(['gsc', 'ga', 'gbp', 'bing', 'ads', 'google-ads', 'gtm', 'traffic'])
export const StatusIntegrations = statusIntegrationSchema.enum
export type StatusIntegration = z.infer<typeof statusIntegrationSchema>

export const integrationStateSchema = z.enum(['ok', 'failing', 'stale', 'never-synced'])
export const IntegrationStates = integrationStateSchema.enum
export type IntegrationState = z.infer<typeof integrationStateSchema>

const dateTimeSchema = z.string().datetime({ offset: true })
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const integrationStatusRowSchema = z.object({
  integration: statusIntegrationSchema,
  label: z.string(),
  runKind: runKindSchema,
  sourceId: z.string().nullable(),
  state: integrationStateSchema,
  lastSuccessAt: dateTimeSchema.nullable(),
  latestRunAt: dateTimeSchema.nullable(),
  latestRunId: z.string().nullable(),
  latestStatus: runStatusSchema.nullable(),
  latestTrigger: runTriggerSchema.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  latestError: z.string().max(300).nullable(),
  dataThrough: dateSchema.nullable(),
  dataAgeDays: z.number().int().nonnegative().nullable(),
  doctorChecks: z.array(z.string()),
})
export type IntegrationStatusRow = z.infer<typeof integrationStatusRowSchema>

export const statusHealthSchema = z.object({
  status: z.enum(['ok', 'warn', 'fail']),
  code: z.string(),
  summary: z.string(),
  checkedAt: dateTimeSchema,
  notifiedAt: dateTimeSchema.nullable(),
})
export type StatusHealth = z.infer<typeof statusHealthSchema>

export const projectStatusSchema = z.object({
  project: z.string(),
  displayName: z.string(),
  state: z.enum([...integrationStateSchema.options, 'warning']),
  health: statusHealthSchema.nullable(),
  integrations: z.array(integrationStatusRowSchema),
})
export type ProjectStatus = z.infer<typeof projectStatusSchema>

export const instanceStatusDtoSchema = z.object({
  generatedAt: dateTimeSchema,
  summary: z.object({
    projects: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    failing: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative().optional(),
    stale: z.number().int().nonnegative(),
    neverSynced: z.number().int().nonnegative(),
  }),
  projects: z.array(projectStatusSchema),
})
export type InstanceStatusDto = z.infer<typeof instanceStatusDtoSchema>
