import { z } from 'zod'
import { SENTIMENT_MODEL, SENTIMENT_OPENROUTER_MODEL, sentimentEvaluatorProviderSchema } from '@canonry/canonry-contracts'

/** Private install configuration. Never serialize this object in public DTOs. */
export const sentimentInstallConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: sentimentEvaluatorProviderSchema.default('typesafe'),
  apiKey: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).default(SENTIMENT_MODEL),
  maxConcurrency: z.number().int().min(1).max(8).default(2),
  maxRequestsPerMinute: z.number().int().min(1).max(10_000).default(60),
  maxInputTokensPerMinute: z.number().int().min(1).max(10_000_000).default(100_000),
  maxAttempts: z.number().int().min(1).max(5).default(3),
}).strict()
export type SentimentInstallConfig = z.output<typeof sentimentInstallConfigSchema> & {
  /** Set by the install loader when config.yaml is missing, unreadable or invalid. Never ready, and not an operator disable. */
  invalid?: true
}
export type SentimentInstallConfigInput = z.input<typeof sentimentInstallConfigSchema>

/** Explicit env values win. Invalid switches fail closed rather than enabling spend. */
export function resolveSentimentInstallConfig(
  env: NodeJS.ProcessEnv,
  value?: SentimentInstallConfigInput,
  providerKeys?: { openrouter?: string },
): SentimentInstallConfig {
  const enabled = env.CANONRY_SENTIMENT_ENABLED?.trim().toLowerCase()
  const provider = env.CANONRY_SENTIMENT_PROVIDER ?? value?.provider ?? 'typesafe'
  const model = env.CANONRY_SENTIMENT_MODEL ?? (provider === 'typesafe' ? env.TYPESAFE_MODEL : undefined) ?? value?.model ?? (provider === 'openrouter' ? SENTIMENT_OPENROUTER_MODEL : SENTIMENT_MODEL)
  const apiKey = provider === 'openrouter' ? env.OPENROUTER_API_KEY ?? providerKeys?.openrouter : env.TYPESAFE_API_KEY ?? value?.apiKey
  return sentimentInstallConfigSchema.parse({
    ...value,
    provider, model, apiKey: apiKey?.trim() || undefined,
    ...(enabled ? { enabled: enabled === '1' || enabled === 'true' } : {}),
  })
}

/** Only 'install-disabled' is an operator disable; every other reason holds dispatch without canceling work. */
export function sentimentInstallReadiness(config: SentimentInstallConfig): {
  enabled: boolean; ready: boolean; reason: 'invalid-config' | 'install-disabled' | 'missing-credentials' | 'unsupported-model' | null
} {
  const reason = config.invalid ? 'invalid-config'
    : !config.enabled ? 'install-disabled'
    : config.model !== (config.provider === 'openrouter' ? SENTIMENT_OPENROUTER_MODEL : SENTIMENT_MODEL) ? 'unsupported-model'
      : !config.apiKey ? 'missing-credentials' : null
  return { enabled: config.enabled, ready: reason === null, reason }
}
