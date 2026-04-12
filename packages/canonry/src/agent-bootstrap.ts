import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentConfigEntry } from './config.js'
import { CliError } from './cli-error.js'

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

export interface InstallResult {
  success: boolean
  detection?: DetectionResult
  error?: string
}

/**
 * Install OpenClaw globally via npm and return the detection result.
 * Resets the detection cache before re-probing.
 */
export async function installOpenClaw(opts?: { silent?: boolean }): Promise<InstallResult> {
  try {
    execSync('npm install -g openclaw', {
      timeout: 120_000,
      stdio: opts?.silent ? 'pipe' : 'inherit',
    })
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Reset cache so detectOpenClaw re-probes
  detectOpenClaw.resetCache()

  const detection = await detectOpenClaw()
  if (!detection.found) {
    return {
      success: false,
      error: 'npm install succeeded but openclaw binary was not found in PATH',
    }
  }

  return { success: true, detection }
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

/**
 * Initialize the OpenClaw profile non-interactively.
 * Tolerates "already configured" — throws on real failures.
 */
export function initializeOpenClawProfile(binary: string, profile: string, workspaceDir: string): void {
  try {
    execFileSync(binary, [
      '--profile', profile,
      'onboard',
      '--non-interactive',
      '--accept-risk',
      '--mode', 'local',
      '--workspace', workspaceDir,
      '--skip-channels',
      '--skip-skills',
      '--skip-health',
      '--no-install-daemon',
    ], { timeout: 30_000, stdio: 'pipe' })
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : ''
    // "already configured" or "already exists" is tolerated
    if (stderr.toLowerCase().includes('already')) return
    throw new CliError({
      code: 'AGENT_PROFILE_INIT_FAILED',
      message: `Failed to initialize OpenClaw profile: ${stderr || (err instanceof Error ? err.message : String(err))}`,
      displayMessage: `Failed to initialize OpenClaw profile "${profile}".`,
    })
  }
}

/**
 * Configure the OpenClaw gateway for canonry-managed operation.
 * Sets gateway.mode=local and gateway.port.
 */
export function configureOpenClawGateway(binary: string, profile: string, gatewayPort: number): void {
  const entries: [string, string, boolean][] = [
    ['gateway.mode', 'local', false],
    ['gateway.port', String(gatewayPort), true],
  ]
  for (const [key, value, strict] of entries) {
    try {
      const args = ['--profile', profile, 'config', 'set', key, value]
      if (strict) args.push('--strict-json')
      execFileSync(binary, args, { timeout: 10_000, stdio: 'pipe' })
    } catch (err) {
      throw new CliError({
        code: 'AGENT_GATEWAY_CONFIG_FAILED',
        message: `Failed to set ${key}=${value}: ${err instanceof Error ? err.message : String(err)}`,
        displayMessage: `Failed to configure OpenClaw gateway (${key}).`,
      })
    }
  }
}

/**
 * Set the default model for the OpenClaw agent.
 */
export function setOpenClawModel(binary: string, profile: string, model: string): void {
  try {
    execFileSync(binary, [
      '--profile', profile,
      'models', 'set', model,
    ], { timeout: 10_000, stdio: 'pipe' })
  } catch (err) {
    throw new CliError({
      code: 'AGENT_MODEL_SET_FAILED',
      message: `Failed to set agent model to ${model}: ${err instanceof Error ? err.message : String(err)}`,
      displayMessage: `Failed to set agent model to "${model}".`,
    })
  }
}

/** Map a provider id to the conventional env var OpenClaw checks. */
export function providerEnvVar(provider: string): string {
  const map: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    'google-vertex': 'GOOGLE_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    xai: 'XAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
  }
  return map[provider] ?? `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

/** Upsert a KEY=value line in a dotenv file inside stateDir. */
export function writeAgentEnv(stateDir: string, key: string, value: string): void {
  const envFile = path.join(stateDir, '.env')
  let lines: string[] = []
  if (fs.existsSync(envFile)) {
    lines = fs.readFileSync(envFile, 'utf-8').split('\n')
  }

  const prefix = `${key}=`
  const idx = lines.findIndex(l => l.startsWith(prefix))
  const entry = `${key}=${value}`
  if (idx >= 0) {
    lines[idx] = entry
  } else {
    lines.push(entry)
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  fs.writeFileSync(envFile, lines.join('\n') + '\n', 'utf-8')
}

/**
 * Resolve agent credentials from flags, env vars, or existing .env.
 * Returns resolved credentials. Throws if no key is resolvable and .env is empty.
 */
export function resolveAgentCredentials(opts: {
  agentProvider?: string
  agentKey?: string
  agentModel?: string
  stateDir: string
}): { provider: string; key?: string; model?: string } {
  const provider = opts.agentProvider ?? 'anthropic'

  // 1. Flags take priority
  if (opts.agentKey) {
    return { provider, key: opts.agentKey, model: opts.agentModel }
  }

  // 2. Check provider-specific env var
  const envVar = providerEnvVar(provider)
  const envKey = process.env[envVar]
  if (envKey) {
    return { provider, key: envKey, model: opts.agentModel }
  }

  // 3. Check generic CANONRY_AGENT_KEY env var
  const genericKey = process.env.CANONRY_AGENT_KEY
  if (genericKey) {
    return { provider, key: genericKey, model: opts.agentModel }
  }

  // 4. Check existing .env in stateDir (already configured)
  const envFile = path.join(opts.stateDir, '.env')
  if (fs.existsSync(envFile)) {
    const hasKey = fs.readFileSync(envFile, 'utf-8').split('\n').some(l => l.includes('_API_KEY='))
    if (hasKey) {
      return { provider, key: undefined, model: opts.agentModel }
    }
  }

  // 5. No credentials found — not an error, caller decides what to do
  return { provider, key: undefined, model: opts.agentModel }
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
