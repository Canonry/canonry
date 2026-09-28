import fs from 'node:fs'
import { parse } from 'yaml'
import { resolveSentimentInstallConfig, type SentimentInstallConfig, type SentimentInstallConfigInput } from '@ainyc/canonry-config'
import { getConfigPath } from './config.js'

/**
 * Read config.yaml and process.env on every invocation, including every outbound
 * attempt. A live file disable takes effect without a server restart.
 *
 * Only a readable config.yaml that resolves to `enabled: false` is an install
 * disable, which cancels pending work. A missing, unreadable or invalid file (a
 * misspelled key, an out-of-range limit, an empty or unparseable file) fails
 * closed, even with an enabled environment, but is marked `invalid` so dispatch
 * holds and queued work survives until the file is fixed.
 */
export function loadSentimentInstallConfig(): SentimentInstallConfig {
  try {
    const document: unknown = parse(fs.readFileSync(getConfigPath(), 'utf8'))
    const sentiment: unknown = isRecord(document) ? document.sentiment : undefined
    if (!isRecord(document) || (sentiment != null && !isRecord(sentiment))) return invalidSentimentInstallConfig()
    return resolveSentimentInstallConfig(process.env, (sentiment ?? undefined) as SentimentInstallConfigInput | undefined)
  } catch {
    return invalidSentimentInstallConfig()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Disabled, so nothing is sent; `invalid` tells it apart from an operator disable. */
function invalidSentimentInstallConfig(): SentimentInstallConfig {
  return { ...resolveSentimentInstallConfig({}, { enabled: false }), invalid: true }
}
