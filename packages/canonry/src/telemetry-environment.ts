import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { normalizeInstallRef, type InstallSource, type TelemetryEnvironmentFlag } from '@ainyc/canonry-contracts'
import { getConfigDir, loadConfigRaw, saveConfigPatch } from './config.js'
import { detectInstallMethod } from './update-check.js'

const _require = createRequire(import.meta.url)

/** The package root: two levels above it is the monorepo root only in a source checkout. */
function packageRoot(): string | undefined {
  try {
    return path.dirname(_require.resolve('../package.json'))
  } catch {
    return undefined
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

interface DetectOptions {
  env?: NodeJS.ProcessEnv
  configDir?: string
  root?: string
  exists?: (p: string) => boolean
  tmpDirs?: string[]
}

/**
 * Flags that say an install is automation or development, so analysis can
 * drop it at the source instead of guessing from event shapes. An ordinary
 * install returns none. CI is not detected here: telemetry is off under CI.
 */
export function detectTelemetryEnvironment(opts: DetectOptions = {}): TelemetryEnvironmentFlag[] {
  const env = opts.env ?? process.env
  const exists = opts.exists ?? fs.existsSync
  const flags: TelemetryEnvironmentFlag[] = []
  if (detectInstallMethod({ env, exists }) === 'docker' || env.KUBERNETES_SERVICE_HOST) flags.push('container')
  // Compare literal and resolved forms: on macOS /tmp is /private/tmp, and a
  // config dir that does not exist yet cannot be resolved.
  const configDir = opts.configDir ?? getConfigDir()
  const configForms = [path.resolve(configDir), realpath(configDir)]
  const tmpForms = (opts.tmpDirs ?? [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp']).flatMap(dir => [path.resolve(dir), realpath(dir)])
  const underTmp = configForms.some(c => tmpForms.some(t => c === t || c.startsWith(`${t}${path.sep}`)))
  if (underTmp) flags.push('temp_config')
  const root = opts.root ?? packageRoot()
  if (root && exists(path.join(root, '..', '..', 'pnpm-workspace.yaml'))) flags.push('dev_build')
  if (env.CANONRY_TELEMETRY_SOURCE === 'wp-plugin') flags.push('wp_subprocess')
  return flags
}

let cached: TelemetryEnvironmentFlag[] | undefined

/** Detected once per process; the envelope carries it on every event. */
export function telemetryEnvironment(): TelemetryEnvironmentFlag[] {
  cached ??= detectTelemetryEnvironment()
  return cached
}

/** How this copy was installed; a repository checkout reports `source`. */
export function installSource(): InstallSource {
  return telemetryEnvironment().includes('dev_build') ? 'source' : detectInstallMethod()
}

/**
 * Keep the first campaign tag an install arrives with (`--ref` or
 * `CANONRY_REF`). Later tags never overwrite it: attribution is first touch.
 * Invalid tags are ignored rather than failing setup.
 */
export function recordInstallRef(ref?: string, env: NodeJS.ProcessEnv = process.env): void {
  const value = normalizeInstallRef(ref ?? env.CANONRY_REF)
  if (!value) return
  try {
    const raw = loadConfigRaw()
    if (!raw || raw.installRef) return
    saveConfigPatch({ installRef: value })
  } catch {
    // Attribution must never fail setup.
  }
}

/** Install source and first-touch tag for install-level events. */
export function installAttribution(): { installSource: InstallSource; installRef?: string } {
  let installRef: string | undefined
  try {
    installRef = normalizeInstallRef(loadConfigRaw()?.installRef)
  } catch {
    installRef = undefined
  }
  return installRef ? { installSource: installSource(), installRef } : { installSource: installSource() }
}
