import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../config.js'
import type { CliFormat } from '../cli-error.js'
import { CliError } from '../cli-error.js'

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

async function waitForReady(host: string, port: string, maxMs = 10000): Promise<boolean> {
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/health`
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

export async function startDaemon(opts: { port?: string; host?: string; basePath?: string; format?: CliFormat }): Promise<void> {
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

  const cliPath = path.resolve(new URL(import.meta.url).pathname)
  // Don't use --import tsx in production (compiled) installs — tsx is a dev dependency
  const inSourceMode = new URL(import.meta.url).pathname.endsWith('.ts')
  const args = inSourceMode ? ['--import', 'tsx', cliPath, 'serve'] : [cliPath, 'serve']
  if (opts.port) args.push('--port', opts.port)
  if (opts.host) args.push('--host', opts.host)
  if (opts.basePath) args.push('--base-path', opts.basePath)

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })

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

  const port = opts.port ?? '4100'
  const host = opts.host ?? '127.0.0.1'
  if (format !== 'json') {
    process.stderr.write('Waiting for server to start...')
  }
  const ready = await waitForReady(host, port)
  if (!ready) {
    // Server didn't come up — clean up the PID file to avoid leaving a stale one
    try { fs.unlinkSync(pidPath) } catch { /* ignore */ }
    throw new CliError({
      code: 'DAEMON_START_TIMEOUT',
      message: 'Failed to start: server did not respond within 10s',
      displayMessage: '\nFailed to start: server did not respond within 10s',
      details: {
        host,
        port,
        pid: child.pid,
      },
    })
  }
  if (format !== 'json') {
    process.stderr.write('\n')
  }

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`
  if (format === 'json') {
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
    if (format === 'json') {
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
    if (format === 'json') {
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
    if (format === 'json') {
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
    if (format === 'json') {
      console.log(JSON.stringify({
        stopped: true,
        pid,
      }, null, 2))
      return
    }
    console.log(`Canonry stopped (PID: ${pid})`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
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
