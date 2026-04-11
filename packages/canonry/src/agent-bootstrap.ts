import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentConfigEntry } from './config.js'

export interface DetectionResult {
  found: boolean
  path?: string
  version?: string
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes (DenchClaw pattern)
let cachedResult: DetectionResult | null = null
let cachedAt = 0

/**
 * Resolve the state directory for an OpenClaw profile.
 * Default profile is 'aero' → ~/.openclaw-aero/
 */
export function getAeroStateDir(profile = 'aero'): string {
  return path.join(os.homedir(), `.openclaw-${profile}`)
}

/**
 * Detect whether OpenClaw is available.
 *
 * Detection order (follows DenchClaw `bootstrap-external.ts` pattern):
 * 1. Check config.binary path + run `--version` probe
 * 2. Fall back to `which openclaw` (or `where` on Windows)
 * 3. Cache result with 5-min TTL
 */
export async function detectOpenClaw(config?: AgentConfigEntry): Promise<DetectionResult> {
  if (cachedResult && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedResult
  }

  let result: DetectionResult

  // 1. Try configured binary path
  if (config?.binary) {
    const version = probeVersion(config.binary)
    if (version) {
      result = { found: true, path: config.binary, version }
      cachedResult = result
      cachedAt = Date.now()
      return result
    }
  }

  // 2. Fall back to PATH lookup
  const binaryPath = findInPath()
  if (binaryPath) {
    const version = probeVersion(binaryPath)
    if (version) {
      result = { found: true, path: binaryPath, version }
      cachedResult = result
      cachedAt = Date.now()
      return result
    }
  }

  result = { found: false }
  cachedResult = result
  cachedAt = Date.now()
  return result
}

/** Allow tests to reset the detection cache */
detectOpenClaw.resetCache = () => {
  cachedResult = null
  cachedAt = 0
}

/**
 * Run `openclaw --version` and extract the version string.
 * Returns null if the binary doesn't respond.
 */
function probeVersion(binaryPath: string): string | null {
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      timeout: 5000,
      encoding: 'utf-8',
    })
    // Parse "openclaw X.Y.Z" or just "X.Y.Z"
    const match = output.toString().trim().match(/(\d+\.\d+\.\d+)/)
    return match ? match[1] : output.toString().trim()
  } catch {
    return null
  }
}

/**
 * Find `openclaw` binary in PATH using `which` (Unix) or `where` (Windows).
 */
function findInPath(): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const output = execFileSync(cmd, ['openclaw'], {
      timeout: 5000,
      encoding: 'utf-8',
    })
    return output.toString().trim().split('\n')[0] || null
  } catch {
    return null
  }
}

/**
 * Seed the agent workspace directory with bundled assets (AGENTS.md, SOUL.md,
 * skills). Idempotent — overwrites existing files to ensure they stay current.
 */
export function seedWorkspace(stateDir: string): void {
  const workspaceDir = path.join(stateDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })

  // Resolve the bundled agent-workspace assets directory.
  // In the published package this is at packages/canonry/assets/agent-workspace/
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const assetsDir = path.join(__dirname, '..', 'assets', 'agent-workspace')

  if (!fs.existsSync(assetsDir)) {
    // Running from source without a build — skip seeding silently
    return
  }

  copyDirRecursive(assetsDir, workspaceDir)
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}
