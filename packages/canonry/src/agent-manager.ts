import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentConfigEntry } from './config.js'
import { createLogger } from './logger.js'

const log = createLogger('AgentManager')

/** Marker stored in process.json to verify process identity on PID reuse. */
const PROCESS_MARKER = 'canonry-openclaw-gateway'

export interface AgentStatus {
  state: 'running' | 'stopped'
  pid?: number
  port?: number
  startedAt?: string
}

interface ProcessInfo {
  pid: number
  gatewayPort: number
  startedAt: string
  marker: string
}

/**
 * Manages the OpenClaw gateway process lifecycle.
 * Follows DenchClaw's `web-runtime.ts` daemon management pattern:
 * - process.json for rich PID tracking (not bare PID file)
 * - Detached child process with stdio to logs
 * - SIGTERM → poll → SIGKILL escalation
 */
export class AgentManager {
  private processJsonPath: string

  constructor(
    private config: AgentConfigEntry,
    private stateDir: string,
  ) {
    this.processJsonPath = path.join(stateDir, 'process.json')
  }

  /**
   * Check if the gateway process is running.
   * Cleans up stale process.json if the process is dead or belongs to a
   * different process (PID reuse).
   */
  status(): AgentStatus {
    const info = this.readProcessInfo()
    if (!info) {
      return { state: 'stopped' }
    }

    if (info.marker !== PROCESS_MARKER) {
      // process.json from an older format or corrupted — treat as stale
      this.removeProcessJson()
      return { state: 'stopped' }
    }

    if (isProcessAlive(info.pid) && this.verifyProcessIdentity(info.pid)) {
      return {
        state: 'running',
        pid: info.pid,
        port: info.gatewayPort,
        startedAt: info.startedAt,
      }
    }

    // Stale process.json — clean up
    this.removeProcessJson()
    return { state: 'stopped' }
  }

  /**
   * Start the OpenClaw gateway as a detached background process.
   * Idempotent — no-op if already running.
   * Waits briefly for the process to confirm it hasn't crashed on startup.
   */
  async start(): Promise<void> {
    const currentStatus = this.status()
    if (currentStatus.state === 'running') {
      log.info('already.running', { pid: currentStatus.pid })
      return
    }

    const binary = this.config.binary ?? 'openclaw'
    const profile = this.config.profile ?? 'aero'
    const port = this.config.gatewayPort ?? 3579

    // Ensure state dir exists for log files
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true })
    }

    const logFile = path.join(this.stateDir, 'gateway.log')
    const logFd = fs.openSync(logFile, 'a')

    // Load .env from state dir (agent API keys persisted by setup)
    const dotEnv = this.loadDotEnv()

    const child = spawn(binary, ['--profile', profile, 'gateway'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        ...dotEnv,
        OPENCLAW_PROFILE: profile,
        OPENCLAW_GATEWAY_PORT: String(port),
        OPENCLAW_STATE_DIR: this.stateDir,
      },
    })

    // Capture spawn errors and early exits before writing process.json.
    // Listen for both 'error' (spawn failure) and 'exit' (immediate crash).
    const startupResult = await new Promise<{ error?: Error; exitCode?: number | null }>((resolve) => {
      let settled = false
      const settle = (r: { error?: Error; exitCode?: number | null }) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      child.on('error', (err) => settle({ error: err }))
      child.on('exit', (code) => settle({ exitCode: code }))
      // Allow a brief window for the process to crash on startup
      setTimeout(() => settle({}), 500)
    })

    child.unref()
    fs.closeSync(logFd)

    if (startupResult.error) {
      throw new Error(`Failed to start OpenClaw gateway: ${startupResult.error.message}`)
    }

    if (startupResult.exitCode != null) {
      throw new Error(`OpenClaw gateway exited immediately (code ${startupResult.exitCode}). Check ${path.join(this.stateDir, 'gateway.log')} for details.`)
    }

    if (child.pid == null) {
      throw new Error('Failed to start OpenClaw gateway: no PID returned by spawn')
    }

    // Verify the process is still alive before persisting state
    if (!isProcessAlive(child.pid)) {
      throw new Error(`OpenClaw gateway exited immediately after spawn. Check ${path.join(this.stateDir, 'gateway.log')} for details.`)
    }

    const processInfo: ProcessInfo = {
      pid: child.pid,
      gatewayPort: port,
      startedAt: new Date().toISOString(),
      marker: PROCESS_MARKER,
    }

    fs.writeFileSync(this.processJsonPath, JSON.stringify(processInfo, null, 2), 'utf-8')
    log.info('started', { pid: child.pid, port })
  }

  /**
   * Stop the gateway process.
   * Uses DenchClaw escalation: SIGTERM → 800ms poll → SIGKILL.
   * Idempotent — no-op if already stopped.
   */
  async stop(): Promise<void> {
    const info = this.readProcessInfo()
    if (!info) return

    if (isProcessAlive(info.pid) && info.marker === PROCESS_MARKER && this.verifyProcessIdentity(info.pid)) {
      await terminateWithEscalation(info.pid)
    }

    this.removeProcessJson()
    log.info('stopped', { pid: info.pid })
  }

  /**
   * Stop the gateway, wipe the workspace directory, and prepare for re-seeding.
   */
  async reset(): Promise<void> {
    await this.stop()

    const workspaceDir = path.join(this.stateDir, 'workspace')
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true })
      log.info('workspace.wiped', { dir: workspaceDir })
    }
  }

  /**
   * Verify that the PID actually belongs to an openclaw process by checking
   * the full command line. Requires "openclaw" in the args to avoid matching
   * unrelated Node processes after PID reuse.
   */
  private verifyProcessIdentity(pid: number): boolean {
    try {
      if (process.platform === 'darwin') {
        const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
          encoding: 'utf-8',
          timeout: 2000,
        }).trim()
        return out.includes('openclaw')
      }
      if (process.platform === 'linux') {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
        return cmdline.includes('openclaw')
      }
      // On unsupported platforms, trust the PID (no false negatives)
      return true
    } catch {
      // Process gone or no permission — treat as not ours
      return false
    }
  }

  private readProcessInfo(): ProcessInfo | null {
    if (!fs.existsSync(this.processJsonPath)) return null
    try {
      return JSON.parse(fs.readFileSync(this.processJsonPath, 'utf-8'))
    } catch {
      return null
    }
  }

  private removeProcessJson(): void {
    try {
      fs.unlinkSync(this.processJsonPath)
    } catch {
      // Already gone
    }
  }

  /** Parse a simple KEY=value dotenv file from the state dir. */
  private loadDotEnv(): Record<string, string> {
    const envFile = path.join(this.stateDir, '.env')
    if (!fs.existsSync(envFile)) return {}
    const result: Record<string, string> = {}
    for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 1) continue
      result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return result
  }
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

/**
 * DenchClaw escalation pattern from `terminatePidWithEscalation()`:
 * SIGTERM → poll every 100ms for 800ms → SIGKILL
 */
async function terminateWithEscalation(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // Already dead
  }

  // Poll for 800ms
  const deadline = Date.now() + 800
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  // Escalate to SIGKILL
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already dead
  }
}
