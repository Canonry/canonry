import crypto from 'node:crypto'
import type { CanonryConfig } from './config.js'
import { CliError } from './cli-error.js'

const MIN_SECRET_LENGTH = 32

/**
 * The install secret that keys AI visitor journey hashes. The environment
 * (`CANONRY_JOURNEY_KEY_SECRET`) wins, for hosted installs that keep secrets
 * outside the config file; then `journeys.visitorKeySecret`; else a new random
 * secret is generated once and saved to the config file, so visitor keys stay
 * stable across restarts. If the file cannot be written, the secret lasts for
 * this process only and `warn` says so. Never logged or returned by any route.
 */
export function resolveJourneyKeySecret(
  config: CanonryConfig,
  env: NodeJS.ProcessEnv,
  persist: (patch: Partial<CanonryConfig>) => void,
  warn: (message: string) => void = message => process.stderr.write(`${message}\n`),
): string {
  const fromEnv = env.CANONRY_JOURNEY_KEY_SECRET?.trim()
  if (fromEnv) {
    if (fromEnv.length < MIN_SECRET_LENGTH) {
      throw new CliError({
        code: 'CONFIG_INVALID',
        message: `CANONRY_JOURNEY_KEY_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`,
      })
    }
    return fromEnv
  }
  const stored = config.journeys?.visitorKeySecret?.trim()
  if (stored) return stored
  const secret = crypto.randomBytes(32).toString('hex')
  config.journeys = { ...(config.journeys ?? {}), visitorKeySecret: secret }
  try {
    persist({ journeys: config.journeys })
  } catch (error) {
    warn(`Could not save journeys.visitorKeySecret to the config file (${error instanceof Error ? error.message : String(error)}). AI visitor keys will change on the next restart.`)
  }
  return secret
}
