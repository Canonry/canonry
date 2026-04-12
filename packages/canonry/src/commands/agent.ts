import path from 'node:path'
import { AgentManager } from '../agent-manager.js'
import { loadConfig, saveConfigPatch, configExists } from '../config.js'
import type { AgentConfigEntry } from '../config.js'
import {
  detectOpenClaw,
  installOpenClaw,
  getAeroStateDir,
  seedWorkspace,
  initializeOpenClawProfile,
  configureOpenClawGateway,
  setOpenClawModel,
  providerEnvVar,
  writeAgentEnv,
  resolveAgentCredentials,
} from '../agent-bootstrap.js'
import { initCommand } from './init.js'
import type { InitOptions } from './init.js'

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

export interface AgentSetupOptions extends Omit<InitOptions, 'force' | 'format'> {
  gatewayPort?: number
  format?: string
  stateDir?: string
}

export async function agentSetup(opts?: AgentSetupOptions): Promise<void> {
  const isJson = opts?.format === 'json'

  // 1. Initialize canonry if not already configured
  // When --format json, suppress init's own output so we emit one JSON object
  let agentLLM: { provider: string; key?: string; model?: string } | undefined
  if (!configExists()) {
    const initOpts = {
      geminiKey: opts?.geminiKey,
      openaiKey: opts?.openaiKey,
      claudeKey: opts?.claudeKey,
      perplexityKey: opts?.perplexityKey,
      localUrl: opts?.localUrl,
      localModel: opts?.localModel,
      localKey: opts?.localKey,
      googleClientId: opts?.googleClientId,
      googleClientSecret: opts?.googleClientSecret,
      agentProvider: opts?.agentProvider,
      agentKey: opts?.agentKey,
      agentModel: opts?.agentModel,
    }
    if (isJson) {
      agentLLM = await suppressStdout(() => initCommand(initOpts)) ?? undefined
    } else {
      agentLLM = await initCommand(initOpts) ?? undefined
    }
  }

  // 2. Detect or install OpenClaw
  const existingConfig = resolveConfig()
  let detection = await detectOpenClaw(existingConfig)
  if (!detection.found) {
    detection = await autoInstallOrFail(opts?.format)
  }

  // 3. Persist agent config to canonry config.yaml
  const profile = existingConfig.profile ?? 'aero'
  const gatewayPort = opts?.gatewayPort ?? existingConfig.gatewayPort ?? 3579
  const stateDir = opts?.stateDir ?? getAeroStateDir(profile)

  saveConfigPatch({
    agent: {
      binary: detection.path,
      profile,
      gatewayPort,
      autoStart: existingConfig.autoStart,
    },
  })

  // 4. Initialize and configure OpenClaw profile
  initializeOpenClawProfile(detection.path!, profile, path.join(stateDir, 'workspace'))
  configureOpenClawGateway(detection.path!, profile, gatewayPort)

  // 5. Configure agent LLM credentials
  const creds = agentLLM ?? resolveAgentCredentials({
    agentProvider: opts?.agentProvider,
    agentKey: opts?.agentKey,
    agentModel: opts?.agentModel,
    stateDir,
  })
  if (creds.key) {
    writeAgentEnv(stateDir, providerEnvVar(creds.provider), creds.key)
    if (opts?.format !== 'json') {
      console.log(`Agent LLM: ${creds.provider} credentials configured`)
    }
  }
  if (creds.model) {
    setOpenClawModel(detection.path!, profile, creds.model)
    if (opts?.format !== 'json') {
      console.log(`Agent model: ${creds.model}`)
    }
  }

  // 6. Seed workspace with canonry skills
  seedWorkspace(stateDir)

  // 7. Output result
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

async function autoInstallOrFail(format?: string) {
  if (format !== 'json') {
    console.log('OpenClaw not found, installing via npm...')
  }

  const install = await installOpenClaw({ silent: format === 'json' })

  if (!install.success) {
    const msg = `Failed to install OpenClaw: ${install.error}`
    if (format === 'json') {
      console.error(JSON.stringify({ error: { code: 'AGENT_INSTALL_FAILED', message: msg } }))
    } else {
      console.error(msg)
    }
    process.exitCode = 1
    throw new Error(msg)
  }

  if (format !== 'json') {
    console.log(`Installed OpenClaw ${install.detection!.version}`)
  }

  return install.detection!
}

/** Suppress console.log during an async operation. Returns the operation's result. */
async function suppressStdout<T>(fn: () => T | Promise<T>): Promise<T> {
  const original = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = original
  }
}
