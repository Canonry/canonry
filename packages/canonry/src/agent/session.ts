import fs from 'node:fs'
import path from 'node:path'
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentOptions, AgentTool } from '@mariozechner/pi-agent-core'
import { registerBuiltInApiProviders, type Model } from '@mariozechner/pi-ai'
import type { DatabaseClient } from '@ainyc/canonry-db'
import type { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import {
  agentProviderApiKeyEnvVar,
  agentProvidersByPriority,
  coerceAgentProvider,
  getAgentProvider,
  resolveApiKeyFor,
  resolveModelForProvider,
  validateAgentProviderRegistry,
  type SupportedAgentProvider,
} from './providers.js'
import { resolveAeroSkillDir } from './skill-paths.js'
import { buildSkillDocTools } from './skill-tools.js'
import {
  AeroToolProfiles,
  AeroToolScopes,
  buildAeroStateTools,
  type AeroToolProfile,
  type AeroToolScope,
} from './tools.js'
import {
  AERO_PROMPT_FAMILY,
  AERO_PROMPT_VERSION,
  AeroLlmUsageFeatures,
  recordLlmUsageEvent,
} from './llm-usage.js'
import { splitAeroAnthropicSystemCachePayload } from './prompt-cache.js'
import { configureAeroRuntime } from './runtime.js'
import { buildAeroViewTool, AERO_RUNTIME_PROMPT } from './view-context.js'
import { createAeroToolUsageHooks } from './tool-usage.js'

export type { SupportedAgentProvider } from './providers.js'
export { AgentProviders, listAgentProviders, coerceAgentProvider } from './providers.js'

let builtinsRegistered = false
function ensureBuiltinsRegistered(): void {
  if (!builtinsRegistered) {
    registerBuiltInApiProviders()
    validateAgentProviderRegistry()
    builtinsRegistered = true
  }
}

export interface AeroSessionOptions {
  projectName: string
  client: ApiClient
  config: CanonryConfig
  /** Explicit pi-ai provider. Default: auto-detect from configured API keys. */
  provider?: SupportedAgentProvider
  /** Explicit model id within the chosen provider. Default: provider's default. */
  modelId?: string
  /** Override system prompt (skips aero skill file load). Useful for tests. */
  systemPromptOverride?: string
  /** Override streamFn — used by tests via pi-ai's faux provider. */
  streamFn?: AgentOptions['streamFn']
  /** Override tool set. Default: `buildAllTools({ client, projectName })` — reads + writes. */
  tools?: AgentTool[]
  /**
   * Tool surface scope. 'all' exposes reads + writes (default). 'read-only'
   * exposes only the read tools — used by the dashboard bar where we don't
   * yet have a confirmation UX for destructive/additive actions.
   */
  toolScope?: AeroToolScope
  /** Optional profile that narrows the tool surface for specific operator workflows. */
  toolProfile?: AeroToolProfile
  /** Seed initial transcript. Used by the registry when rehydrating a persisted session. */
  initialMessages?: import('@mariozechner/pi-agent-core').AgentMessage[]
  /** Optional telemetry context. When present, assistant turn usage is appended to llm_usage_events. */
  db?: DatabaseClient
  projectId?: string
  agentSessionId?: string
}

export { resolveAeroSkillDir } from './skill-paths.js'

/**
 * Compose the system prompt from soul.md (identity/voice) + SKILL.md (task
 * rules). Soul is optional — SKILL.md alone is a valid prompt — but when
 * present it's prepended so identity frames the task instructions.
 */
export function loadAeroSystemPrompt(pkgDir?: string): string {
  const skillDir = resolveAeroSkillDir(pkgDir)
  const skillBody = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')
  const soulPath = path.join(skillDir, 'soul.md')
  const base = fs.existsSync(soulPath)
    ? `${fs.readFileSync(soulPath, 'utf-8').trimEnd()}\n\n---\n\n${skillBody}`
    : skillBody
  return appendSystemPromptExtras(base + AERO_RUNTIME_PROMPT)
}

/**
 * Generic system-prompt APPEND seam (OSS-D). Appends `AERO_SYSTEM_PROMPT_APPEND`
 * (inline) and/or the contents of `AERO_SYSTEM_PROMPT_FILE` (a file path) AFTER
 * the base soul+SKILL prompt, separated by a divider. Empty by default, so a
 * default install is byte-identical. Generic: carries no product vocabulary.
 *
 * Lives inside `loadAeroSystemPrompt` so it covers BOTH the one-shot
 * `createAeroSession` default path AND the registry (which builds on
 * `loadAeroSystemPrompt`, then layers the dynamic `<memory>` block AFTER, so the
 * appended rules frame the task and sit before per-session memory). A
 * `systemPromptOverride` (tests / explicit full control) deliberately bypasses
 * this. A missing or unreadable file is skipped, never breaking the agent. The
 * FILE variant exists so a multi-KB prompt is mounted as a file rather than
 * crammed into a single `-e` env arg. Exported for tests.
 */
export function appendSystemPromptExtras(
  base: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const inline = env.AERO_SYSTEM_PROMPT_APPEND?.trim()
  let fileBody = ''
  const filePath = env.AERO_SYSTEM_PROMPT_FILE?.trim()
  if (filePath) {
    try {
      fileBody = fs.readFileSync(filePath, 'utf-8').trim()
    } catch {
      fileBody = ''
    }
  }
  const extras = [inline, fileBody].filter((s): s is string => !!s && s.length > 0)
  if (extras.length === 0) return base
  return `${base.trimEnd()}\n\n---\n\n${extras.join('\n\n')}`
}

function missingProviderMessage(): string {
  const configHints = agentProvidersByPriority().join(', ')
  const envHints = agentProvidersByPriority().map(agentProviderApiKeyEnvVar).join(' / ')
  return (
    `No agent LLM provider configured. Add an API key for one of: ${configHints} in ` +
    `~/.canonry/config.yaml, or export ${envHints}.`
  )
}

/**
 * The provider pinned by `agent.provider`, or undefined when unset.
 *
 * Config load rejects an unknown id outright, so coercing again here only
 * covers callers that build a `CanonryConfig` in memory (tests, embedders) and
 * never went through that validation.
 */
export function resolveConfiguredAgentProvider(config: CanonryConfig): SupportedAgentProvider | undefined {
  return coerceAgentProvider(config.agent?.provider)
}

/** What doctor reports about an `agent.provider` pin. */
export interface AgentPinStatus {
  provider: SupportedAgentProvider
  model: string
  configured: boolean
  envVar: string
  modelError: string | null
}

/**
 * The `agent.provider` pin as doctor reports it: the provider and model Aero is
 * held to, whether a key resolves for it, and whether the model id resolves.
 * Null when nothing is pinned. Both failures otherwise surface only when a
 * turn runs, since a pin bypasses the key check auto-detection performs.
 */
export function describeAgentPin(config: CanonryConfig): AgentPinStatus | null {
  const provider = resolveConfiguredAgentProvider(config)
  if (!provider) return null
  const model = config.agent?.model ?? getAgentProvider(provider).defaultModel
  let modelError: string | null = null
  try {
    resolveAeroModel(provider, model)
  } catch (err) {
    modelError = err instanceof Error ? err.message : String(err)
  }
  return {
    provider,
    model,
    configured: Boolean(resolveApiKeyFor(provider, config)),
    envVar: agentProviderApiKeyEnvVar(provider),
    modelError,
  }
}

/** Pick the first configured agent provider — canonry config first, then pi-ai env-var fallback. */
export function detectAgentProvider(config: CanonryConfig): SupportedAgentProvider | undefined {
  for (const provider of agentProvidersByPriority()) {
    if (resolveApiKeyFor(provider, config)) return provider
  }
  return undefined
}

export function resolveAeroModel(
  provider: SupportedAgentProvider,
  modelId?: string,
): Model<never> {
  ensureBuiltinsRegistered()
  return resolveModelForProvider(provider, modelId)
}

/** Resolver used by pi's `getApiKey` callback — `resolveApiKeyFor` handles canonry config and env-var fallback. */
export function buildApiKeyResolver(
  config: CanonryConfig,
): (piAiProvider: string) => string | undefined {
  return (piAiProvider: string) => resolveApiKeyFor(piAiProvider, config)
}

function buildAeroProviderSessionId(opts: AeroSessionOptions): string {
  return `canonry:aero:${opts.agentSessionId ?? opts.projectId ?? opts.projectName}`
}

export function createAeroSession(opts: AeroSessionOptions): Agent {
  const systemPrompt = opts.systemPromptOverride ?? loadAeroSystemPrompt()

  const provider = opts.provider ?? detectAgentProvider(opts.config)
  if (!provider) throw new Error(missingProviderMessage())

  const model = resolveAeroModel(provider, opts.modelId)

  const toolScope = opts.toolScope ?? AeroToolScopes.all
  const toolProfile = opts.toolProfile ?? AeroToolProfiles.default
  const toolCtx = {
    client: opts.client,
    projectName: opts.projectName,
  }
  // Skill-doc tools ride in both scopes — they're pure reads of bundled
  // assets, no project state involved.
  const stateTools = buildAeroStateTools(toolCtx, { scope: toolScope, profile: toolProfile })
  const defaultTools = [...stateTools, ...buildSkillDocTools(), ...(toolProfile === AeroToolProfiles.default ? [buildAeroViewTool({ ...toolCtx, basePath: opts.config.basePath })] : [])]
  const tools = opts.tools ?? defaultTools
  const toolUsageHooks = opts.db
    ? createAeroToolUsageHooks({
        db: opts.db,
        projectId: opts.projectId,
        agentSessionId: opts.agentSessionId,
        metadata: { projectName: opts.projectName },
      })
    : {}

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools,
      ...(opts.initialMessages ? { messages: opts.initialMessages } : {}),
    },
    streamFn: opts.streamFn,
    sessionId: buildAeroProviderSessionId(opts),
    onPayload: splitAeroAnthropicSystemCachePayload,
    ...toolUsageHooks,
    getApiKey: buildApiKeyResolver(opts.config),
  })

  configureAeroRuntime(agent, tools, undefined, !opts.tools && toolProfile === AeroToolProfiles.default)

  const telemetryDb = opts.db
  if (telemetryDb) {
    agent.subscribe((event) => {
      if (event.type !== 'turn_end') return
      if (event.message.role !== 'assistant') return
      recordLlmUsageEvent({
        db: telemetryDb,
        projectId: opts.projectId,
        agentSessionId: opts.agentSessionId,
        feature: AeroLlmUsageFeatures.turn,
        promptFamily: AERO_PROMPT_FAMILY,
        promptVersion: AERO_PROMPT_VERSION,
        message: event.message,
        metadata: { projectName: opts.projectName, toolCount: agent.state.tools.length },
      })
    })
  }

  return agent
}

/** Exposed so the registry can persist the chosen provider/model without re-running detection. */
export function resolveSessionProviderAndModel(
  config: CanonryConfig,
  opts?: { provider?: SupportedAgentProvider; modelId?: string },
): { provider: SupportedAgentProvider; modelId: string } {
  const pinned = resolveConfiguredAgentProvider(config)
  const provider = opts?.provider ?? pinned ?? detectAgentProvider(config)
  if (!provider) throw new Error(missingProviderMessage())
  // `agent.model` belongs to `agent.provider`. Applying it to a provider the
  // caller asked for instead would send one host's slug to another, so it
  // counts only when the pin is what actually won.
  const pinnedModelId = provider === pinned ? config.agent?.model : undefined
  const modelId = opts?.modelId ?? pinnedModelId ?? getAgentProvider(provider).defaultModel
  return { provider, modelId }
}
