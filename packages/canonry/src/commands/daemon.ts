import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../config.js'

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

export function startDaemon(opts: { port?: string; host?: string }): void {
  const pidPath = getPidPath()

  // Check for existing process
  if (fs.existsSync(pidPath)) {
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
    if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
      console.error(`Canonry is already running (PID: ${existingPid})`)
      process.exit(1)
    }
    // Stale PID file — remove it
    fs.unlinkSync(pidPath)
  }

  const cliPath = path.resolve(new URL('../cli.js', import.meta.url).pathname)
  // Don't use --import tsx in production (compiled) installs — tsx is a dev dependency
  const inSourceMode = new URL(import.meta.url).pathname.endsWith('.ts')
  const args = inSourceMode ? ['--import', 'tsx', cliPath, 'serve'] : [cliPath, 'serve']
  if (opts.port) args.push('--port', opts.port)
  if (opts.host) args.push('--host', opts.host)

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })

  child.unref()

  if (!child.pid) {
    console.error('Failed to start Canonry server')
    process.exit(1)
  }

  // Ensure config dir exists
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  fs.writeFileSync(pidPath, String(child.pid), 'utf-8')

  const port = opts.port ?? '4100'
  const host = opts.host ?? '127.0.0.1'
  console.log(`Canonry started (PID: ${child.pid}), listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`)
}

export function stopDaemon(): void {
  const pidPath = getPidPath()

  if (!fs.existsSync(pidPath)) {
    console.log('Canonry is not running (no PID file found)')
    return
  }

  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)

  if (isNaN(pid)) {
    console.error('Invalid PID file. Removing it.')
    fs.unlinkSync(pidPath)
    return
  }

  if (!isProcessAlive(pid)) {
    console.log(`Canonry is not running (stale PID: ${pid}). Cleaning up.`)
    fs.unlinkSync(pidPath)
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
    fs.unlinkSync(pidPath)
    console.log(`Canonry stopped (PID: ${pid})`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Failed to stop Canonry (PID: ${pid}): ${msg}`)
    process.exit(1)
  }
}
