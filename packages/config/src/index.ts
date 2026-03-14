import { providerQuotaPolicySchema, getDefaultModel, type ProviderQuotaPolicy } from '@ainyc/canonry-contracts'
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://aeo:aeo@postgres:5432/aeo_platform'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  WEB_PORT: z.coerce.number().int().positive().default(4173),
  BOOTSTRAP_SECRET: z.string().default('change-me'),
  // Gemini
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  GEMINI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  GEMINI_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  GEMINI_MAX_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(1000),
  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  OPENAI_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  OPENAI_MAX_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(1000),
  // Anthropic / Claude
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  ANTHROPIC_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  ANTHROPIC_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  ANTHROPIC_MAX_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(1000),
})

export interface ProviderEnvConfig {
  apiKey: string
  model?: string
  quota: ProviderQuotaPolicy
}

export interface LocalBootstrapProviderConfig {
  apiKey?: string
  baseUrl: string
  model?: string
  quota: ProviderQuotaPolicy
}

export interface BootstrapEnv {
  apiKey?: string
  apiUrl?: string
  databasePath?: string
  googleClientId?: string
  googleClientSecret?: string
  providers: {
    gemini?: ProviderEnvConfig
    openai?: ProviderEnvConfig
    claude?: ProviderEnvConfig
    local?: LocalBootstrapProviderConfig
  }
}

export interface PlatformEnv {
  databaseUrl: string
  apiPort: number
  workerPort: number
  webPort: number
  bootstrapSecret: string
  providers: {
    gemini?: ProviderEnvConfig
    openai?: ProviderEnvConfig
    claude?: ProviderEnvConfig
  }
}

const bootstrapEnvSchema = z.object({
  CANONRY_API_KEY: z.string().optional(),
  CANONRY_API_URL: z.string().optional(),
  CANONRY_DATABASE_PATH: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  LOCAL_BASE_URL: z.string().optional(),
  LOCAL_API_KEY: z.string().optional(),
  LOCAL_MODEL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
})

export function getPlatformEnv(source: NodeJS.ProcessEnv): PlatformEnv {
  const parsed = envSchema.parse(source)

  const providers: PlatformEnv['providers'] = {}

  if (parsed.GEMINI_API_KEY) {
    providers.gemini = {
      apiKey: parsed.GEMINI_API_KEY,
      model: parsed.GEMINI_MODEL,
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: parsed.GEMINI_MAX_CONCURRENCY,
        maxRequestsPerMinute: parsed.GEMINI_MAX_REQUESTS_PER_MINUTE,
        maxRequestsPerDay: parsed.GEMINI_MAX_REQUESTS_PER_DAY,
      }),
    }
  }

  if (parsed.OPENAI_API_KEY) {
    providers.openai = {
      apiKey: parsed.OPENAI_API_KEY,
      model: parsed.OPENAI_MODEL,
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: parsed.OPENAI_MAX_CONCURRENCY,
        maxRequestsPerMinute: parsed.OPENAI_MAX_REQUESTS_PER_MINUTE,
        maxRequestsPerDay: parsed.OPENAI_MAX_REQUESTS_PER_DAY,
      }),
    }
  }

  if (parsed.ANTHROPIC_API_KEY) {
    providers.claude = {
      apiKey: parsed.ANTHROPIC_API_KEY,
      model: parsed.ANTHROPIC_MODEL,
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: parsed.ANTHROPIC_MAX_CONCURRENCY,
        maxRequestsPerMinute: parsed.ANTHROPIC_MAX_REQUESTS_PER_MINUTE,
        maxRequestsPerDay: parsed.ANTHROPIC_MAX_REQUESTS_PER_DAY,
      }),
    }
  }

  return {
    databaseUrl: parsed.DATABASE_URL,
    apiPort: parsed.API_PORT,
    workerPort: parsed.WORKER_PORT,
    webPort: parsed.WEB_PORT,
    bootstrapSecret: parsed.BOOTSTRAP_SECRET,
    providers,
  }
}

export function getBootstrapEnv(
  source: NodeJS.ProcessEnv,
  overrides?: Partial<Record<string, string | undefined>>,
): BootstrapEnv {
  const filtered = overrides
    ? Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null))
    : {}
  const parsed = bootstrapEnvSchema.parse({ ...source, ...filtered })
  const providers: BootstrapEnv['providers'] = {}

  if (parsed.GEMINI_API_KEY) {
    providers.gemini = {
      apiKey: parsed.GEMINI_API_KEY,
      model: parsed.GEMINI_MODEL || getDefaultModel('gemini'),
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: 2,
        maxRequestsPerMinute: 10,
        maxRequestsPerDay: 500,
      }),
    }
  }

  if (parsed.OPENAI_API_KEY) {
    providers.openai = {
      apiKey: parsed.OPENAI_API_KEY,
      model: parsed.OPENAI_MODEL || getDefaultModel('openai'),
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: 2,
        maxRequestsPerMinute: 10,
        maxRequestsPerDay: 500,
      }),
    }
  }

  if (parsed.ANTHROPIC_API_KEY) {
    providers.claude = {
      apiKey: parsed.ANTHROPIC_API_KEY,
      model: parsed.ANTHROPIC_MODEL || getDefaultModel('claude'),
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: 2,
        maxRequestsPerMinute: 10,
        maxRequestsPerDay: 500,
      }),
    }
  }

  if (parsed.LOCAL_BASE_URL) {
    providers.local = {
      baseUrl: parsed.LOCAL_BASE_URL,
      apiKey: parsed.LOCAL_API_KEY,
      model: parsed.LOCAL_MODEL || getDefaultModel('local'),
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: 2,
        maxRequestsPerMinute: 10,
        maxRequestsPerDay: 500,
      }),
    }
  }

  return {
    apiKey: parsed.CANONRY_API_KEY,
    apiUrl: parsed.CANONRY_API_URL,
    databasePath: parsed.CANONRY_DATABASE_PATH,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    providers,
  }
}
