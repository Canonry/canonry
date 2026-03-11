import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse, stringify } from 'yaml'
import type { ProviderQuotaPolicy } from '@ainyc/canonry-contracts'

export interface ProviderConfigEntry {
  apiKey?: string
  baseUrl?: string
  model?: string
  quota?: ProviderQuotaPolicy
}

export interface CanonryConfig {
  apiUrl: string
  database: string
  apiKey: string
  port?: number
  // Legacy single-provider fields (backward compat)
  geminiApiKey?: string
  geminiModel?: string
  geminiQuota?: ProviderQuotaPolicy
  // Multi-provider config
  providers?: {
    gemini?: ProviderConfigEntry
    openai?: ProviderConfigEntry
    claude?: ProviderConfigEntry
    local?: ProviderConfigEntry
  }
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
      `Config not found at ${configPath}. Run "canonry init" to create one.`,
    )
  }
  const raw = fs.readFileSync(configPath, 'utf-8')
  const parsed = parse(raw) as CanonryConfig
  if (!parsed.apiUrl || !parsed.database || !parsed.apiKey) {
    throw new Error(
      `Invalid config at ${configPath}. Required fields: apiUrl, database, apiKey`,
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
