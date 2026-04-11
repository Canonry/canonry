import { AgentManager } from '../agent-manager.js'
import { loadConfig, saveConfigPatch } from '../config.js'
import type { AgentConfigEntry } from '../config.js'
import { detectOpenClaw, getAeroStateDir, seedWorkspace } from '../agent-bootstrap.js'

function resolveStateDir(opts?: { stateDir?: string }): string {
  if (opts?.stateDir) return opts.stateDir
  try {
    const config = loadConfig()
    const profile = config.agent?.profile ?? 'aero'
    return getAeroStateDir(profile)
  } catch {
    return getAeroStateDir()
  }
}

function resolveConfig(): AgentConfigEntry {
  try {
    return loadConfig().agent ?? {}
  } catch {
    return {}
  }
}

export async function agentStatus(opts?: { format?: string; stateDir?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts)
  const config = resolveConfig()
  const mgr = new AgentManager(config, stateDir)
  const status = mgr.status()

  if (opts?.format === 'json') {
    console.log(JSON.stringify(status, null, 2))
    return
  }

  if (status.state === 'running') {
    console.log(`Agent: running (PID ${status.pid}, port ${status.port})`)
    if (status.startedAt) {
      console.log(`Started: ${status.startedAt}`)
    }
  } else {
    console.log('Agent: stopped')
  }
}

export async function agentStart(opts?: { format?: string; stateDir?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts)
  const config = resolveConfig()
  const mgr = new AgentManager(config, stateDir)

  await mgr.start()

  const status = mgr.status()
  if (opts?.format === 'json') {
    console.log(JSON.stringify(status, null, 2))
  } else {
    console.log(`Agent started (PID ${status.pid}, port ${status.port})`)
  }
}

export async function agentStop(opts?: { format?: string; stateDir?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts)
  const config = resolveConfig()
  const mgr = new AgentManager(config, stateDir)

  await mgr.stop()

  if (opts?.format === 'json') {
    console.log(JSON.stringify({ state: 'stopped' }, null, 2))
  } else {
    console.log('Agent stopped')
  }
}

export async function agentReset(opts?: { format?: string; stateDir?: string }): Promise<void> {
  const stateDir = resolveStateDir(opts)
  const config = resolveConfig()
  const mgr = new AgentManager(config, stateDir)

  await mgr.reset()

  if (opts?.format === 'json') {
    console.log(JSON.stringify({ state: 'reset' }, null, 2))
  } else {
    console.log('Agent reset — workspace wiped. Run "canonry agent setup" to re-initialize.')
  }
}

export async function agentSetup(opts?: {
  gatewayPort?: number
  format?: string
  stateDir?: string
}): Promise<void> {
  const existingConfig = resolveConfig()
  const detection = await detectOpenClaw(existingConfig)

  if (!detection.found) {
    const msg = 'OpenClaw not found. Install it with: npm install -g openclaw'
    if (opts?.format === 'json') {
      console.error(JSON.stringify({ error: { code: 'AGENT_NOT_FOUND', message: msg } }))
    } else {
      console.error(msg)
    }
    process.exitCode = 1
    return
  }

  // Build the agent config to persist
  const profile = existingConfig.profile ?? 'aero'
  const gatewayPort = opts?.gatewayPort ?? existingConfig.gatewayPort ?? 3579
  const agentConfig: AgentConfigEntry = {
    binary: detection.path,
    profile,
    gatewayPort,
    autoStart: existingConfig.autoStart,
  }

  // Persist to config.yaml
  saveConfigPatch({ agent: agentConfig })

  // Seed the workspace directory with AGENTS.md, SOUL.md, and skills
  const stateDir = opts?.stateDir ?? getAeroStateDir(profile)
  seedWorkspace(stateDir)

  if (opts?.format === 'json') {
    console.log(JSON.stringify({
      state: 'configured',
      binary: detection.path,
      version: detection.version,
      profile,
      gatewayPort,
      stateDir,
    }, null, 2))
  } else {
    console.log(`OpenClaw: ${detection.path} (${detection.version})`)
    console.log(`Profile: ${profile}`)
    console.log(`Gateway port: ${gatewayPort}`)
    console.log(`State dir: ${stateDir}`)
    console.log('Agent setup complete.')
  }
}
