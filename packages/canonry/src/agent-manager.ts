import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentConfigEntry } from './config.js'
import { createLogger } from './logger.js'

const log = createLogger('AgentManager')

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
   * Cleans up stale process.json if the process is dead.
   */
  status(): AgentStatus {
    const info = this.readProcessInfo()
    if (!info) {
      return { state: 'stopped' }
    }

    if (isProcessAlive(info.pid)) {
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

    const child = spawn(binary, ['--profile', profile, 'gateway', 'start'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        OPENCLAW_PROFILE: profile,
        OPENCLAW_GATEWAY_PORT: String(port),
        OPENCLAW_STATE_DIR: this.stateDir,
      },
    })

    child.unref()
    fs.closeSync(logFd)

    const processInfo: ProcessInfo = {
      pid: child.pid!,
      gatewayPort: port,
      startedAt: new Date().toISOString(),
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

    if (isProcessAlive(info.pid)) {
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
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
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
