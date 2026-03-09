import { providerQuotaPolicySchema, type ProviderQuotaPolicy } from '@ainyc/aeo-platform-contracts'
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://aeo:aeo@postgres:5432/aeo_platform'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  WEB_PORT: z.coerce.number().int().positive().default(4173),
  BOOTSTRAP_SECRET: z.string().default('change-me'),
  GEMINI_API_KEY: z.string().default('change-me'),
  GEMINI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  GEMINI_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  GEMINI_MAX_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(1000),
})

export interface PlatformEnv {
  databaseUrl: string
  apiPort: number
  workerPort: number
  webPort: number
  bootstrapSecret: string
  geminiApiKey: string
  providerQuota: ProviderQuotaPolicy
}

export function getPlatformEnv(source: NodeJS.ProcessEnv): PlatformEnv {
  const parsed = envSchema.parse(source)

  return {
    databaseUrl: parsed.DATABASE_URL,
    apiPort: parsed.API_PORT,
    workerPort: parsed.WORKER_PORT,
    webPort: parsed.WEB_PORT,
    bootstrapSecret: parsed.BOOTSTRAP_SECRET,
    geminiApiKey: parsed.GEMINI_API_KEY,
    providerQuota: providerQuotaPolicySchema.parse({
      maxConcurrency: parsed.GEMINI_MAX_CONCURRENCY,
      maxRequestsPerMinute: parsed.GEMINI_MAX_REQUESTS_PER_MINUTE,
      maxRequestsPerDay: parsed.GEMINI_MAX_REQUESTS_PER_DAY,
    }),
  }
}
