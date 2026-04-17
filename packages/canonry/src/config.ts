import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse, stringify } from 'yaml'
import type { ProviderQuotaPolicy } from '@ainyc/canonry-contracts'

export type GoogleConnectionType = 'gsc' | 'ga4'

export interface ProviderConfigEntry {
  apiKey?: string
  baseUrl?: string
  model?: string
  quota?: ProviderQuotaPolicy
  /** Vertex AI GCP project ID (Gemini provider only) */
  vertexProject?: string
  /** Vertex AI region, e.g. "us-central1" (Gemini provider only) */
  vertexRegion?: string
  /** Path to service account JSON for Vertex AI auth (falls back to ADC) */
  vertexCredentials?: string
}

export interface CdpConfigEntry {
  host?: string
  port?: number
  quota?: ProviderQuotaPolicy
}

export interface GoogleConnectionConfigEntry {
  domain: string
  connectionType: GoogleConnectionType
  propertyId?: string | null
  sitemapUrl?: string | null
  accessToken?: string
  refreshToken?: string | null
  tokenExpiresAt?: string | null
  scopes?: string[]
  createdAt: string
  updatedAt: string
}

export interface GoogleConfigEntry {
  clientId?: string
  clientSecret?: string
  connections?: GoogleConnectionConfigEntry[]
}

export interface BingConnectionConfigEntry {
  domain: string
  apiKey: string
  siteUrl?: string | null
  createdAt: string
  updatedAt: string
}

export interface BingConfigEntry {
  apiKey?: string
  connections?: BingConnectionConfigEntry[]
}

export interface Ga4ConnectionConfigEntry {
  projectName: string
  propertyId: string
  clientEmail: string
  privateKey: string
  createdAt: string
  updatedAt: string
}

export interface Ga4ConfigEntry {
  connections?: Ga4ConnectionConfigEntry[]
}

export type WordpressEnv = 'live' | 'staging'

export interface WordpressConnectionConfigEntry {
  projectName: string
  url: string
  stagingUrl?: string
  username: string
  appPassword: string
  defaultEnv: WordpressEnv
  createdAt: string
  updatedAt: string
}

export interface WordpressConfigEntry {
  connections?: WordpressConnectionConfigEntry[]
}

export interface AgentConfigEntry {
  /** Agent mode. Only 'disabled' is valid until the native loop ships. */
  mode?: 'disabled'
}

export interface CanonryConfig {
  apiUrl: string
  publicUrl?: string
  /** Sub-path prefix when canonry is served behind a reverse proxy (e.g. "/canonry/"). */
  basePath?: string
  database: string
  apiKey: string
  port?: number
  // Legacy single-provider fields (backward compat)
  geminiApiKey?: string
  geminiModel?: string
  geminiQuota?: ProviderQuotaPolicy
  // Multi-provider config (API providers) — keyed by adapter name
  providers?: Record<string, ProviderConfigEntry>
  // CDP browser provider config (separate from API providers)
  cdp?: CdpConfigEntry
  google?: GoogleConfigEntry
  bing?: BingConfigEntry
  ga4?: Ga4ConfigEntry
  wordpress?: WordpressConfigEntry
  // Dashboard password hash (SHA-256 hex) — set during first dashboard visit
  dashboardPasswordHash?: string
  // Telemetry (opt-out: undefined/true = enabled, false = disabled)
  telemetry?: boolean
  anonymousId?: string
  // Agent layer configuration (reserved — native loop TBD)
  agent?: AgentConfigEntry
}

function normalizeGoogleConfig(config: CanonryConfig): void {
  if (!config.google) return
  config.google.connections = (config.google.connections ?? []).map((connection) => ({
    ...connection,
    propertyId: connection.propertyId ?? null,
    refreshToken: connection.refreshToken ?? null,
    tokenExpiresAt: connection.tokenExpiresAt ?? null,
    scopes: connection.scopes ?? [],
  }))
}

function normalizeWordpressConfig(config: CanonryConfig): void {
  if (!config.wordpress) return
  config.wordpress.connections = (config.wordpress.connections ?? []).map((connection) => ({
    ...connection,
    url: connection.url.replace(/\/$/, ''),
    stagingUrl: connection.stagingUrl?.replace(/\/$/, ''),
    defaultEnv: connection.defaultEnv ?? 'live',
  }))
}

export function getConfigDir(): string {
  const override = process.env.CANONRY_CONFIG_DIR?.trim()
  if (override) {
    return override
  }

  return path.join(os.homedir(), '.canonry')
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.yaml')
}

export function loadConfig(): CanonryConfig {
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config not found at ${configPath}.\n` +
      'Run "canonry init" to set up interactively, or "canonry init --gemini-key <key>" for non-interactive setup.\n' +
      'For CI/Docker, use "canonry bootstrap" with env vars (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).',
    )
  }
  const raw = fs.readFileSync(configPath, 'utf-8')
  const parsed = parse(raw) as CanonryConfig
  if (!parsed.apiUrl || !parsed.database || !parsed.apiKey) {
    const missing = [
      !parsed.apiUrl && 'apiUrl',
      !parsed.database && 'database',
      !parsed.apiKey && 'apiKey',
    ].filter(Boolean).join(', ')
    throw new Error(
      `Invalid config at ${configPath} — missing: ${missing}.\n` +
      'These fields are auto-generated. Run "canonry init" (or "canonry init --gemini-key <key>" for non-interactive setup) to create a valid config.\n' +
      'Do not write config.yaml by hand; use "canonry init", "canonry settings", or "canonry bootstrap" instead.',
    )
  }

  // Migrate legacy geminiApiKey to providers map
  if (parsed.geminiApiKey && !parsed.providers?.gemini) {
    parsed.providers = {
      ...parsed.providers,
      gemini: {
        apiKey: parsed.geminiApiKey,
        model: parsed.geminiModel,
        quota: parsed.geminiQuota,
      },
    }
  }

  normalizeGoogleConfig(parsed)
  normalizeWordpressConfig(parsed)

  // Honor CANONRY_PORT env var — overrides apiUrl port so that CLI client
  // commands (status, run, etc.) connect to the same port as `canonry serve --port`.
  const portOverride = process.env.CANONRY_PORT?.trim()
  if (portOverride) {
    try {
      const url = new URL(parsed.apiUrl)
      url.port = portOverride
      parsed.apiUrl = url.origin
    } catch {
      // invalid URL in config, leave as-is
    }
  }

  // Honor CANONRY_BASE_PATH env var — overrides basePath from config so that CLI
  // client commands route to the correct sub-path when behind a reverse proxy.
  // Check presence (not truthiness) so that CANONRY_BASE_PATH='' explicitly
  // clears a basePath set in config.yaml, matching the server's normalization
  // which treats empty as "no prefix".
  if ('CANONRY_BASE_PATH' in process.env) {
    const val = process.env.CANONRY_BASE_PATH!.trim()
    parsed.basePath = val || undefined
  }

  // If basePath is configured (from config.yaml or CANONRY_BASE_PATH env var),
  // ensure apiUrl includes it so the CLI client constructs correct paths when
  // canonry runs behind a reverse proxy.
  // e.g. apiUrl: http://localhost:4100 + basePath: /canonry/ → effective apiUrl: http://localhost:4100/canonry
  // Safe to re-run: if apiUrl already contains the base path, it is left unchanged.
  if (parsed.basePath) {
    const normalizedBase = '/' + parsed.basePath.replace(/^\/|\/$/g, '')
    try {
      const url = new URL(parsed.apiUrl)
      if (normalizedBase !== '/' && !url.pathname.startsWith(normalizedBase)) {
        parsed.apiUrl = url.origin + normalizedBase
      }
    } catch {
      // invalid URL in config, leave as-is
    }
  }

  return parsed
}

/**
 * Read the raw on-disk config without applying any runtime transformations
 * (env-var overrides, legacy migrations, etc.).  Returns null when the
 * file does not exist or cannot be parsed.
 */
export function loadConfigRaw(): CanonryConfig | null {
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) return null
  try {
    return (parse(fs.readFileSync(configPath, 'utf-8')) as CanonryConfig) ?? null
  } catch {
    return null
  }
}

/**
 * Persist config to disk using a **read-modify-write** strategy.
 *
 * Instead of blindly overwriting the file with the full in-memory config,
 * we re-read the current on-disk state and merge the incoming config on
 * top. This prevents:
 *
 * 1. **Env-var override leakage** — `loadConfig()` mutates `apiUrl` and
 *    `basePath` based on `CANONRY_PORT` / `CANONRY_BASE_PATH`. A naïve
 *    save would persist those runtime-only values back to disk.
 *
 * 2. **Cross-session clobbering** — when `CANONRY_CONFIG_DIR` points to a
 *    test session directory, the in-memory config contains test-specific
 *    values (e.g. a temp `database` path). If another process later calls
 *    `saveConfig` for a targeted change, it should not overwrite unrelated
 *    fields that were loaded from a different session.
 */
export function saveConfig(config: CanonryConfig): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  const configPath = getConfigPath()
  const onDisk = loadConfigRaw()

  // Start with on-disk state as the base so that fields untouched by the
  // caller are preserved exactly as they were on disk.
  const merged: Record<string, unknown> = onDisk
    ? { ...(onDisk as unknown as Record<string, unknown>) }
    : {}

  // Overlay every field from the incoming config.
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      merged[key] = value
    }
  }

  // Restore on-disk values for fields that `loadConfig()` may have mutated
  // via env-var overrides — these are runtime-only and must not leak to disk.
  if (onDisk) {
    if (process.env.CANONRY_PORT?.trim() || onDisk.basePath) {
      merged.apiUrl = onDisk.apiUrl
    }
    if ('CANONRY_BASE_PATH' in process.env) {
      if (onDisk.basePath !== undefined) {
        merged.basePath = onDisk.basePath
      } else {
        delete merged.basePath
      }
    }
  }

  const yaml = stringify(merged)
  fs.writeFileSync(configPath, yaml, { encoding: 'utf-8', mode: 0o600 })
}

/**
 * Perform a targeted (partial) save: read the on-disk config, apply only the
 * specified keys from `patch`, and write back.  Use this for runtime updates
 * (provider settings, connection tokens, etc.) to prevent a server started
 * with a temporary CANONRY_CONFIG_DIR from clobbering production values like
 * `database`, `apiKey`, and `anonymousId`.
 */
export function saveConfigPatch(patch: Partial<CanonryConfig>): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  const configPath = getConfigPath()

  let base: Partial<CanonryConfig> = {}
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
      base = (parse(raw) as Partial<CanonryConfig>) ?? {}
    } catch {
      base = {}
    }
  }

  const merged = { ...base, ...patch }

  // Always preserve these critical production settings if they exist on disk.
  // This prevents a server started with a temporary CANONRY_CONFIG_DIR from
  // overwriting the production config file with its session-specific defaults.
  if (base.database) merged.database = base.database
  if (base.apiKey) merged.apiKey = base.apiKey
  if (base.anonymousId) merged.anonymousId = base.anonymousId
  if (base.dashboardPasswordHash) merged.dashboardPasswordHash = base.dashboardPasswordHash

  // Deep-merge providers: for each provider, preserve keys that exist on disk
  // but are absent or null in the patch (e.g. vertexProject, vertexRegion,
  // vertexCredentials set manually on prod but unknown to a test session).
  if (base.providers && patch.providers) {
    merged.providers = { ...base.providers }
    for (const [key, patchEntry] of Object.entries(patch.providers)) {
      const baseEntry = base.providers[key] ?? {}
      merged.providers[key] = { ...baseEntry, ...patchEntry }
    }
  }

  const yaml = stringify(merged)
  fs.writeFileSync(configPath, yaml, { encoding: 'utf-8', mode: 0o600 })
}

export function configExists(): boolean {
  return fs.existsSync(getConfigPath())
}
