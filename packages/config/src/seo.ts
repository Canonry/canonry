import { z } from 'zod'

export const seoFundingModeSchema = z.enum(['self-hosted', 'hosted'])
export const SeoFundingModes = seoFundingModeSchema.enum
/** Host-only configuration. Neither credentials nor monetary policy enter project DTOs. */
export const seoInstallConfigSchema = z.object({
  enabled: z.boolean(),
  fundingMode: seoFundingModeSchema,
  policy: z.object({
    maxRunCostMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    accountDailyLimitMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    accountMonthlyLimitMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    projectMonthlyLimitMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  connections: z.record(z.string().min(1).max(100), z.discriminatedUnion('provider', [z.object({
    provider: z.literal('dataforseo'),
    label: z.string().min(1).max(120),
    enabled: z.boolean(),
    login: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1000),
  }).strict()])),
}).strict()
export type SeoInstallConfig = z.infer<typeof seoInstallConfigSchema>
