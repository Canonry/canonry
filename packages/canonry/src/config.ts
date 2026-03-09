import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse, stringify } from 'yaml'

export interface CanonryConfig {
  apiUrl: string
  database: string
  apiKey: string
  geminiApiKey: string
  geminiModel?: string
  geminiQuota?: {
    maxConcurrency: number
    maxRequestsPerMinute: number
    maxRequestsPerDay: number
  }
}

export function getConfigDir(): string {
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
  if (!parsed.apiUrl || !parsed.database || !parsed.apiKey || !parsed.geminiApiKey) {
    throw new Error(
      `Invalid config at ${configPath}. Required fields: apiUrl, database, apiKey, geminiApiKey`,
    )
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
