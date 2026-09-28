import { z } from 'zod'

/** Private install configuration. Never serialize this object in public DTOs. */
export const sentimentInstallConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).default('jev-1.13.0'),
  maxConcurrency: z.number().int().min(1).max(8).default(2),
  maxRequestsPerMinute: z.number().int().min(1).max(10_000).default(60),
  maxInputTokensPerMinute: z.number().int().min(1).max(10_000_000).default(100_000),
  maxAttempts: z.number().int().min(1).max(5).default(3),
}).strict()
export type SentimentInstallConfig = z.output<typeof sentimentInstallConfigSchema>
export type SentimentInstallConfigInput = z.input<typeof sentimentInstallConfigSchema>

/** Explicit env values win. Invalid switches fail closed rather than enabling spend. */
export function resolveSentimentInstallConfig(
  env: NodeJS.ProcessEnv,
  value?: SentimentInstallConfigInput,
): SentimentInstallConfig {
  const enabled = env.CANONRY_SENTIMENT_ENABLED?.trim().toLowerCase()
  return sentimentInstallConfigSchema.parse({
    ...value,
    ...(enabled ? { enabled: enabled === '1' || enabled === 'true' } : {}),
    ...(env.TYPESAFE_API_KEY !== undefined ? { apiKey: env.TYPESAFE_API_KEY.trim() || undefined } : {}),
    ...(env.TYPESAFE_MODEL !== undefined ? { model: env.TYPESAFE_MODEL } : {}),
  })
}

export function sentimentInstallReadiness(config: SentimentInstallConfig): {
  enabled: boolean; ready: boolean; reason: 'install-disabled' | 'missing-credentials' | 'unsupported-model' | null
} {
  const reason = !config.enabled ? 'install-disabled'
    : config.model !== 'jev-1.13.0' ? 'unsupported-model'
      : !config.apiKey ? 'missing-credentials' : null
  return { enabled: config.enabled, ready: reason === null, reason }
}
