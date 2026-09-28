import fs from 'node:fs'
import { parse } from 'yaml'
import { resolveSentimentInstallConfig, type SentimentInstallConfig } from '@ainyc/canonry-config'
import { getConfigPath, type CanonryConfig } from './config.js'

/**
 * Read config.yaml and process.env on every invocation, including every outbound
 * attempt. A live file disable takes effect without a server restart. Invalid
 * or unreadable configuration fails closed, even with an enabled environment.
 */
export function loadSentimentInstallConfig(): SentimentInstallConfig {
  try {
    const path = getConfigPath()
    const config = fs.existsSync(path) ? parse(fs.readFileSync(path, 'utf8')) as CanonryConfig | null : null
    return resolveSentimentInstallConfig(process.env, config?.sentiment)
  } catch {
    return resolveSentimentInstallConfig({}, { enabled: false })
  }
}
