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
  // Multi-provider config (API providers)
  providers?: {
    gemini?: ProviderConfigEntry
    openai?: ProviderConfigEntry
    claude?: ProviderConfigEntry
    local?: ProviderConfigEntry
  }
  // CDP browser provider config (separate from API providers)
  cdp?: CdpConfigEntry
  google?: GoogleConfigEntry
  bing?: BingConfigEntry
  // Telemetry (opt-out: undefined/true = enabled, false = disabled)
  telemetry?: boolean
  anonymousId?: string
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
      'For CI/Docker, use "canonry bootstrap" with env vars (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).',
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

  return parsed
}

export function saveConfig(config: CanonryConfig): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
  const yaml = stringify(config)
  fs.writeFileSync(getConfigPath(), yaml, { encoding: 'utf-8', mode: 0o600 })
}

export function configExists(): boolean {
  return fs.existsSync(getConfigPath())
}
