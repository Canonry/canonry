import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir, loadConfig } from '../config.js'
import type { CliFormat } from '../cli-error.js'
import { CliError, isMachineFormat } from '../cli-error.js'
import { describeError } from '@canonry/canonry-contracts'
import { operatorHttpUrl } from '../operator-url.js'
import { resolveServePort } from '../serve-endpoint.js'

function getPidPath(): string {
  return path.join(getConfigDir(), 'canonry.pid')
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but is owned by a different user — still alive
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true
    return false
  }
}

async function answersHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * How long `start` waits for a healthy server. A child that dies is reported
 * as soon as it exits, so this only bounds a slow but live startup (a large
 * database's migrations, a loaded machine), which a short budget would kill.
 */
const START_READY_TIMEOUT_MS = 30_000

/** Poll `/health` until it answers, the child exits, or `maxMs` passes. */
async function waitForReady(
  url: string,
  hasExited: () => boolean,
  maxMs = START_READY_TIMEOUT_MS,
): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (hasExited()) return 'exited'
    if (await answersHealth(url)) return 'ready'
    await new Promise(r => setTimeout(r, 200))
  }
  return hasExited() ? 'exited' : 'timeout'
}

/**
 * Node arguments that run `canonry serve` from the entry the user ran.
 * Re-running this module's own file does not work: the published build
 * bundles it into a shared chunk with no entry point, so that child started
 * nothing and every `canonry start` timed out. `execArgv` keeps loader flags
 * such as `--import tsx` for a source checkout.
 */
export function serveCommandLine(
  entry: string | undefined,
  execArgv: readonly string[],
  forwardArgs: string[],
): string[] {
  if (!entry) {
    throw new CliError({
      code: 'DAEMON_START_FAILED',
      message: 'Cannot find the canonry entry point to start the server. Run "canonry serve" instead.',
      displayMessage: 'Cannot find the canonry entry point to start the server. Run "canonry serve" instead.',
    })
  }
  return [...execArgv, entry, 'serve', ...forwardArgs]
}

export interface ServeForwardOpts {
  port?: string
  host?: string
  basePath?: string
  /** Embed mode (#716) — chromeless render + frame-ancestors framing. */
  embed?: boolean
  embedAllowOrigins?: string[]
  embedViews?: string[]
  embedProjectTabs?: string[]
}

export interface DaemonEndpoint {
  host: string
  port: number
}

/**
 * Resolve the endpoint once in the parent process so the spawned server,
 * readiness probe, and reported URL cannot disagree. CLI flags take
 * precedence over inherited environment, then config, then defaults.
 */
export function resolveDaemonEndpoint(
  opts: Pick<ServeForwardOpts, 'host' | 'port'>,
  env: NodeJS.ProcessEnv,
  configPort: number | undefined,
): DaemonEndpoint {
  const portInput = opts.port || env.CANONRY_PORT
  return {
    host: opts.host || env.CANONRY_HOST || '127.0.0.1',
    port: resolveServePort(portInput, configPort),
  }
}

/**
 * Build the CLI flags `start` forwards to the spawned `serve` child. Embed
 * config rides per-value repeat flags (NOT comma-joined) so each origin/view
 * round-trips through the child's `multiple: true` parse. Embed flags are only
 * forwarded when `--embed` is set (don't forward dead config). Pure + exported
 * for testing.
 */
export function buildServeForwardArgs(opts: ServeForwardOpts): string[] {
  const args: string[] = []
  if (opts.port) args.push('--port', opts.port)
  if (opts.host) args.push('--host', opts.host)
  if (opts.basePath) args.push('--base-path', opts.basePath)
  if (opts.embed) {
    args.push('--embed')
    for (const origin of opts.embedAllowOrigins ?? []) args.push('--embed-allow-origin', origin)
    for (const view of opts.embedViews ?? []) args.push('--embed-view', view)
    for (const projectTab of opts.embedProjectTabs ?? []) args.push('--embed-project-tab', projectTab)
  }
  return args
}

export async function startDaemon(opts: ServeForwardOpts & { format?: CliFormat }): Promise<void> {
  const pidPath = getPidPath()
  const format = opts.format ?? 'text'

  // Check for existing process
  if (fs.existsSync(pidPath)) {
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
    if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
      throw new CliError({
        code: 'DAEMON_ALREADY_RUNNING',
        message: `Canonry is already running (PID: ${existingPid})`,
        displayMessage: `Canonry is already running (PID: ${existingPid})`,
        details: {
          pid: existingPid,
        },
      })
    }
    // Stale PID file — remove it
    fs.unlinkSync(pidPath)
  }

  const config = loadConfig()
  const endpoint = resolveDaemonEndpoint(opts, process.env, config.port)
  const host = endpoint.host
  const port = String(endpoint.port)

  const url = operatorHttpUrl(host, port)
  const healthUrl = `${url}/health`

  // A server already on this port answered the readiness probe, so `start`
  // used to report success for a child that had exited on EADDRINUSE.
  if (await answersHealth(healthUrl)) {
    throw new CliError({
      code: 'DAEMON_ALREADY_RUNNING',
      message: `A server is already running at ${url}`,
      displayMessage: `A server is already running at ${url}`,
      details: { host, port },
    })
  }

  const args = serveCommandLine(process.argv[1], process.execArgv, buildServeForwardArgs({ ...opts, host, port }))

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })

  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  child.once('exit', (code, signal) => { exit = { code, signal } })
  child.unref()

  if (!child.pid) {
    throw new CliError({
      code: 'DAEMON_START_FAILED',
      message: 'Failed to start Canonry server',
      displayMessage: 'Failed to start Canonry server',
    })
  }

  // Ensure config dir exists
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  fs.writeFileSync(pidPath, String(child.pid), 'utf-8')

  if (!isMachineFormat(format)) {
    process.stderr.write('Waiting for server to start...')
  }
  const ready = await waitForReady(healthUrl, () => exit !== undefined)
  if (ready === 'exited') {
    try { fs.unlinkSync(pidPath) } catch { /* ignore */ }
    const how = exit?.signal ? `signal ${exit.signal}` : `code ${exit?.code}`
    throw new CliError({
      code: 'DAEMON_START_FAILED',
      message: `Failed to start: the server exited (${how}) before it was ready. Run "canonry serve" to see why.`,
      displayMessage: `\nFailed to start: the server exited (${how}) before it was ready. Run "canonry serve" to see why.`,
      details: { host, port, pid: child.pid, exitCode: exit?.code ?? null, signal: exit?.signal ?? null },
    })
  }
  if (ready === 'timeout') {
    // Server didn't come up. Stop the child and remove its PID file so a
    // mismatched or failed startup cannot leave an untracked daemon behind.
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    try { fs.unlinkSync(pidPath) } catch { /* ignore */ }
    throw new CliError({
      code: 'DAEMON_START_TIMEOUT',
      message: `Failed to start: server did not respond within ${START_READY_TIMEOUT_MS / 1000}s`,
      displayMessage: `\nFailed to start: server did not respond within ${START_READY_TIMEOUT_MS / 1000}s`,
      details: {
        host,
        port,
        pid: child.pid,
      },
    })
  }
  if (!isMachineFormat(format)) {
    process.stderr.write('\n')
  }

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      started: true,
      pid: child.pid,
      host,
      port: Number.parseInt(port, 10),
      url,
    }, null, 2))
    return
  }

  console.log(`Canonry started (PID: ${child.pid}), listening on ${url}`)
}

export function stopDaemon(format: CliFormat = 'text'): void {
  const pidPath = getPidPath()

  if (!fs.existsSync(pidPath)) {
    if (isMachineFormat(format)) {
      console.log(JSON.stringify({
        stopped: false,
        reason: 'not_running',
      }, null, 2))
      return
    }
    console.log('Canonry is not running (no PID file found)')
    return
  }

  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)

  if (isNaN(pid)) {
    if (isMachineFormat(format)) {
      console.log(JSON.stringify({
        stopped: false,
        reason: 'invalid_pid',
        cleaned: true,
      }, null, 2))
    } else {
      console.error('Invalid PID file. Removing it.')
    }
    fs.unlinkSync(pidPath)
    return
  }

  if (!isProcessAlive(pid)) {
    if (isMachineFormat(format)) {
      console.log(JSON.stringify({
        stopped: false,
        reason: 'stale_pid',
        pid,
        cleaned: true,
      }, null, 2))
    } else {
      console.log(`Canonry is not running (stale PID: ${pid}). Cleaning up.`)
    }
    fs.unlinkSync(pidPath)
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
    fs.unlinkSync(pidPath)
    if (isMachineFormat(format)) {
      console.log(JSON.stringify({
        stopped: true,
        pid,
      }, null, 2))
      return
    }
    console.log(`Canonry stopped (PID: ${pid})`)
  } catch (err) {
    const msg = describeError(err)
    throw new CliError({
      code: 'DAEMON_STOP_FAILED',
      message: `Failed to stop Canonry (PID: ${pid}): ${msg}`,
      displayMessage: `Failed to stop Canonry (PID: ${pid}): ${msg}`,
      details: {
        pid,
      },
    })
  }
}
