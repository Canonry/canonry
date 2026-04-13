import path from 'node:path'
import { createClient, migrate, projects as projectsTable } from '@ainyc/canonry-db'
import { AgentManager } from '../agent-manager.js'
import { createApiClient } from '../client.js'
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
import { attachAgentWebhookDirect, buildAgentWebhookUrl, AGENT_WEBHOOK_EVENTS } from '../agent-webhook.js'
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

  // 7. Attach agent webhook to all existing projects (idempotent)
  const attachSummary = await attachAgentWebhookToAllProjects(gatewayPort)

  // 8. Output result
  if (opts?.format === 'json') {
    console.log(JSON.stringify({
      state: 'configured',
      binary: detection.path,
      version: detection.version,
      profile,
      gatewayPort,
      stateDir,
      attached: attachSummary,
    }, null, 2))
  } else {
    console.log(`OpenClaw: ${detection.path} (${detection.version})`)
    console.log(`Profile: ${profile}`)
    console.log(`Gateway port: ${gatewayPort}`)
    console.log(`State dir: ${stateDir}`)
    if (attachSummary.attached > 0 || attachSummary.alreadyAttached > 0) {
      console.log(
        `Agent webhook: ${attachSummary.attached} attached, ${attachSummary.alreadyAttached} already present (via ${attachSummary.path})`,
      )
    }
    console.log('Agent setup complete.')
  }
}

interface BulkAttachSummary {
  path: 'api' | 'db' | 'skipped'
  attached: number
  alreadyAttached: number
}

/**
 * Attach the agent webhook to every existing project.
 *
 * Tries the API path first (assumes `canonry serve` is running). If that
 * fails with a connection error, falls back to opening the SQLite DB directly
 * — same pattern as `canonry export`, which also works offline. This keeps
 * `canonry agent setup` usable before the server has ever been started.
 */
async function attachAgentWebhookToAllProjects(gatewayPort: number): Promise<BulkAttachSummary> {
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
  } catch {
    return { path: 'skipped', attached: 0, alreadyAttached: 0 }
  }

  // Try API path first
  try {
    const client = createApiClient()
    const projectList = await client.listProjects()
    const agentUrl = buildAgentWebhookUrl(gatewayPort)
    let attached = 0
    let alreadyAttached = 0
    for (const project of projectList) {
      const existing = await client.listNotifications(project.name)
      if (existing.some(n => n.source === 'agent')) {
        alreadyAttached++
        continue
      }
      await client.createNotification(project.name, {
        channel: 'webhook',
        url: agentUrl,
        events: [...AGENT_WEBHOOK_EVENTS],
        source: 'agent',
      })
      attached++
    }
    return { path: 'api', attached, alreadyAttached }
  } catch (err) {
    if (!isConnectionError(err)) throw err
    // Server not running — fall through to direct DB path
  }

  // DB path — same pattern as `canonry export`
  const db = createClient(config.database)
  migrate(db)
  const rows = db.select({ id: projectsTable.id }).from(projectsTable).all()
  let attached = 0
  let alreadyAttached = 0
  for (const row of rows) {
    const result = attachAgentWebhookDirect(db, row.id, gatewayPort)
    if (result === 'attached') attached++
    else alreadyAttached++
  }
  return { path: 'db', attached, alreadyAttached }
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  const code = (err as { code?: string }).code ?? ''
  // ApiClient wraps network failures as CliError with code 'CONNECTION_ERROR'.
  // Raw errors from node:fetch surface as ECONNREFUSED / ENOTFOUND / "fetch failed".
  return (
    code === 'CONNECTION_ERROR' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    msg.includes('could not connect') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('connection refused')
  )
}

export async function agentAttach(opts: { project: string; format?: string }): Promise<void> {
  const config = loadConfig()
  const gatewayPort = config.agent?.gatewayPort ?? 3579
  const agentUrl = buildAgentWebhookUrl(gatewayPort)
  const client = createApiClient()

  // Check if agent webhook already exists (match by source tag, not host)
  const existing = await client.listNotifications(opts.project)
  const hasAgent = existing.some(n => n.source === 'agent')
  if (hasAgent) {
    if (opts.format === 'json') {
      console.log(JSON.stringify({ status: 'already-attached', project: opts.project }))
    } else {
      console.log(`Agent webhook already attached to "${opts.project}"`)
    }
    return
  }

  const result = await client.createNotification(opts.project, {
    channel: 'webhook',
    url: agentUrl,
    events: [...AGENT_WEBHOOK_EVENTS],
    source: 'agent',
  })

  if (opts.format === 'json') {
    console.log(JSON.stringify({ status: 'attached', project: opts.project, notificationId: result.id }))
  } else {
    console.log(`Agent webhook attached to "${opts.project}"`)
  }
}

export async function agentDetach(opts: { project: string; format?: string }): Promise<void> {
  const client = createApiClient()

  const existing = await client.listNotifications(opts.project)
  const agentNotif = existing.find(n => n.source === 'agent')
  if (!agentNotif) {
    if (opts.format === 'json') {
      console.log(JSON.stringify({ status: 'not-attached', project: opts.project }))
    } else {
      console.log(`No agent webhook found on "${opts.project}"`)
    }
    return
  }

  await client.deleteNotification(opts.project, agentNotif.id)

  if (opts.format === 'json') {
    console.log(JSON.stringify({ status: 'detached', project: opts.project }))
  } else {
    console.log(`Agent webhook detached from "${opts.project}"`)
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
