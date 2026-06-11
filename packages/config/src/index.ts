import { parseBooleanFlag, providerQuotaPolicySchema, type ProviderQuotaPolicy } from '@ainyc/canonry-contracts'
import { z } from 'zod'

/**
 * Cloud-mode flag set (Track 1 of the Canonry Hosted v1 spec).
 *
 * Each flag is independent and defaults off so OSS deployments are unaffected.
 * See `.context/control-plane-spec.md` §16 for the full set.
 */
export type CanonryRuntimeMode = 'oss' | 'cloud'

/**
 * `external` disables the in-process node-cron scheduler in
 * `packages/canonry/src/scheduler.ts` — the control plane owns scheduling
 * in cloud deployments. Schedule API endpoints still accept writes so the
 * UI can mirror the control-plane state.
 */
export type CanonrySchedulerMode = 'internal' | 'external'

export interface CloudModeFlags {
  /**
   * Telemetry source flag. When `cloud`, log lines and telemetry events
   * are tagged with `runtime_mode=cloud` for filtering. No behavior change.
   */
  runtimeMode: CanonryRuntimeMode
  /**
   * `external` short-circuits the in-process scheduler (control plane
   * dispatches runs instead). Schedule writes still accepted.
   */
  scheduler: CanonrySchedulerMode
  /**
   * When true, `/settings/*` write endpoints return 403. Read endpoints
   * stay available so the UI can show the managed values.
   */
  managedSettings: boolean
  /**
   * When true, the `/cloud/*` admin-scope endpoints are un-gated (added in
   * Track 3). When false, `requireCloudBootstrap()` throws `notFound()` so
   * the endpoints don't appear.
   */
  enableCloudBootstrap: boolean
}

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://aeo:aeo@postgres:5432/aeo_platform'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  WEB_PORT: z.coerce.number().int().positive().default(4173),
  BOOTSTRAP_SECRET: z.string().default('change-me'),
  CANONRY_BASE_PATH: z.string().default('/'),
  // Default cnry_ bearer the cloud instance authenticates with — seeded into
  // the api_keys table on startup. Required for the dashboard-password
  // session flow (/session/setup binds the session to this key). Optional
  // when the instance is consumed exclusively via external bearer tokens.
  CANONRY_API_KEY: z.string().optional(),
  // Public URL the deployment is reachable at — sets the `Secure` flag on
  // the session cookie when the URL is HTTPS. Without this, the cookie
  // works fine over HTTP (dev) but is not flagged Secure in production.
  CANONRY_PUBLIC_URL: z.string().optional(),
  // Number of reverse-proxy hops in front of apps/api whose appended
  // X-Forwarded-For entries are trusted. Cloud Run / a single load balancer
  // = 1 (the default): request.ip resolves to the rightmost XFF entry — the
  // client IP the platform appended — so per-client rate limiting keys
  // correctly. `trustProxy: true` would take the LEFTMOST entry, which the
  // client controls (spoofable). Set 0 when clients connect directly.
  CANONRY_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  // Cloud-mode flag set — see Track 1 of the Canonry Hosted v1 spec.
  // All four default off so OSS deployments are unaffected.
  CANONRY_RUNTIME_MODE: z.string().optional(),
  CANONRY_SCHEDULER: z.string().optional(),
  CANONRY_MANAGED_SETTINGS: z.string().optional(),
  CANONRY_ENABLE_CLOUD_BOOTSTRAP: z.string().optional(),
  // Control-plane integration — used by the lease-aware quota client.
  CANONRY_CONTROL_PLANE_URL: z.string().optional(),
  // Gemini
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  GEMINI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  GEMINI_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  GEMINI_MAX_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(1000),
  // Gemini Vertex AI (alternative to API key auth)
  GEMINI_VERTEX_PROJECT: z.string().optional(),
  GEMINI_VERTEX_REGION: z.string().optional(),
  GEMINI_VERTEX_CREDENTIALS: z.string().optional(),
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
  // Perplexity
  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_MODEL: z.string().optional(),
  PERPLEXITY_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  PERPLEXITY_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  PERPLEXITY_MAX_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(1000),
  // Secret for HMAC-signing Google OAuth state parameters. Required for
  // cloud deployments that mount googleRoutes; the plugin refuses to register
  // without it (see packages/api-routes/src/google.ts).
  GOOGLE_STATE_SECRET: z.string().optional(),
})

export interface ProviderEnvConfig {
  apiKey: string
  model?: string
  quota: ProviderQuotaPolicy
  vertexProject?: string
  vertexRegion?: string
  vertexCredentials?: string
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
    perplexity?: ProviderEnvConfig
    local?: LocalBootstrapProviderConfig
  }
}

export interface PlatformEnv {
  databaseUrl: string
  apiPort: number
  workerPort: number
  webPort: number
  basePath: string
  bootstrapSecret: string
  /**
   * The default `cnry_…` API key for this cloud instance. Sourced from
   * `CANONRY_API_KEY`. When set, the api-routes session plugin binds
   * dashboard-password sessions to this key on first login; without it,
   * `/session/setup` cannot mint sessions because there's no key for
   * the operator to act as. Cloud Run deployments should always set this.
   */
  apiKey?: string
  /**
   * Public-facing URL of the deployment (no trailing slash). Used to set
   * `Secure` on the session cookie when the public URL is HTTPS so
   * production browsers store and replay it correctly.
   */
  publicUrl?: string
  /**
   * Trusted reverse-proxy hop count for `request.ip` resolution (Fastify
   * `trustProxy`). Defaults to 1 — correct for Cloud Run and any
   * single-proxy topology. 0 disables proxy trust (direct connections).
   * Without this, every client behind the proxy shares one rate-limit
   * bucket: one bot starves the anonymous guest-report budget for
   * everyone and can lock the operator out of dashboard login.
   */
  trustProxyHops: number
  /**
   * Required for cloud deployments that expose Google OAuth routes. Sourced
   * from `GOOGLE_STATE_SECRET`. Undefined when unset — the api-routes plugin
   * will refuse to register googleRoutes in that case, which is the secure
   * default.
   */
  googleStateSecret?: string
  /** Cloud-mode flags. All four default off so OSS deployments are unaffected. */
  cloud: CloudModeFlags
  /**
   * Control-plane base URL (no trailing slash). Used by the lease-aware
   * quota client. Undefined when canonry runs in OSS mode.
   */
  controlPlaneUrl?: string
  providers: {
    gemini?: ProviderEnvConfig
    openai?: ProviderEnvConfig
    claude?: ProviderEnvConfig
    perplexity?: ProviderEnvConfig
  }
}


function parseRuntimeMode(value: string | undefined): CanonryRuntimeMode {
  if (!value) return 'oss'
  return value.trim().toLowerCase() === 'cloud' ? 'cloud' : 'oss'
}

function parseSchedulerMode(value: string | undefined): CanonrySchedulerMode {
  if (!value) return 'internal'
  return value.trim().toLowerCase() === 'external' ? 'external' : 'internal'
}

export function readCloudModeFlags(source: NodeJS.ProcessEnv): CloudModeFlags {
  return {
    runtimeMode: parseRuntimeMode(source.CANONRY_RUNTIME_MODE),
    scheduler: parseSchedulerMode(source.CANONRY_SCHEDULER),
    managedSettings: parseBooleanFlag(source.CANONRY_MANAGED_SETTINGS),
    enableCloudBootstrap: parseBooleanFlag(source.CANONRY_ENABLE_CLOUD_BOOTSTRAP),
  }
}

const bootstrapEnvSchema = z.object({
  CANONRY_API_KEY: z.string().optional(),
  CANONRY_API_URL: z.string().optional(),
  CANONRY_DATABASE_PATH: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  GEMINI_VERTEX_PROJECT: z.string().optional(),
  GEMINI_VERTEX_REGION: z.string().optional(),
  GEMINI_VERTEX_CREDENTIALS: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_MODEL: z.string().optional(),
  LOCAL_BASE_URL: z.string().optional(),
  LOCAL_API_KEY: z.string().optional(),
  LOCAL_MODEL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
})

export function getPlatformEnv(source: NodeJS.ProcessEnv): PlatformEnv {
  const parsed = envSchema.parse(source)

  const providers: PlatformEnv['providers'] = {}

  if (parsed.GEMINI_API_KEY || parsed.GEMINI_VERTEX_PROJECT) {
    providers.gemini = {
      apiKey: parsed.GEMINI_API_KEY ?? '',
      model: parsed.GEMINI_MODEL,
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: parsed.GEMINI_MAX_CONCURRENCY,
        maxRequestsPerMinute: parsed.GEMINI_MAX_REQUESTS_PER_MINUTE,
        maxRequestsPerDay: parsed.GEMINI_MAX_REQUESTS_PER_DAY,
      }),
      vertexProject: parsed.GEMINI_VERTEX_PROJECT,
      vertexRegion: parsed.GEMINI_VERTEX_REGION,
      vertexCredentials: parsed.GEMINI_VERTEX_CREDENTIALS,
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

  if (parsed.PERPLEXITY_API_KEY) {
    providers.perplexity = {
      apiKey: parsed.PERPLEXITY_API_KEY,
      model: parsed.PERPLEXITY_MODEL,
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: parsed.PERPLEXITY_MAX_CONCURRENCY,
        maxRequestsPerMinute: parsed.PERPLEXITY_MAX_REQUESTS_PER_MINUTE,
        maxRequestsPerDay: parsed.PERPLEXITY_MAX_REQUESTS_PER_DAY,
      }),
    }
  }

  return {
    databaseUrl: parsed.DATABASE_URL,
    apiPort: parsed.API_PORT,
    workerPort: parsed.WORKER_PORT,
    webPort: parsed.WEB_PORT,
    basePath: parsed.CANONRY_BASE_PATH,
    bootstrapSecret: parsed.BOOTSTRAP_SECRET,
    apiKey: parsed.CANONRY_API_KEY,
    publicUrl: parsed.CANONRY_PUBLIC_URL?.replace(/\/+$/, ''),
    trustProxyHops: parsed.CANONRY_TRUST_PROXY_HOPS,
    googleStateSecret: parsed.GOOGLE_STATE_SECRET,
    cloud: readCloudModeFlags(source),
    controlPlaneUrl: parsed.CANONRY_CONTROL_PLANE_URL?.replace(/\/+$/, ''),
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

  if (parsed.GEMINI_API_KEY || parsed.GEMINI_VERTEX_PROJECT) {
    providers.gemini = {
      apiKey: parsed.GEMINI_API_KEY ?? '',
      model: parsed.GEMINI_MODEL || 'gemini-2.5-flash',
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: 2,
        maxRequestsPerMinute: 10,
        maxRequestsPerDay: 500,
      }),
      vertexProject: parsed.GEMINI_VERTEX_PROJECT,
      vertexRegion: parsed.GEMINI_VERTEX_REGION,
      vertexCredentials: parsed.GEMINI_VERTEX_CREDENTIALS,
    }
  }

  if (parsed.OPENAI_API_KEY) {
    providers.openai = {
      apiKey: parsed.OPENAI_API_KEY,
      model: parsed.OPENAI_MODEL || 'gpt-5.4',
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
      model: parsed.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      quota: providerQuotaPolicySchema.parse({
        maxConcurrency: 2,
        maxRequestsPerMinute: 10,
        maxRequestsPerDay: 500,
      }),
    }
  }

  if (parsed.PERPLEXITY_API_KEY) {
    providers.perplexity = {
      apiKey: parsed.PERPLEXITY_API_KEY,
      model: parsed.PERPLEXITY_MODEL || 'sonar',
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
      model: parsed.LOCAL_MODEL || 'llama3',
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
