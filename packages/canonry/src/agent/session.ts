import fs from 'node:fs'
import path from 'node:path'
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentOptions, AgentTool } from '@mariozechner/pi-agent-core'
import { registerBuiltInApiProviders, type Model } from '@mariozechner/pi-ai'
import type { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import {
  AGENT_PROVIDERS,
  agentProvidersByPriority,
  getAgentProvider,
  resolveApiKeyFor,
  resolveModelForProvider,
  validateAgentProviderRegistry,
  type SupportedAgentProvider,
} from './providers.js'
import { resolveAeroSkillDir } from './skill-paths.js'
import { buildSkillDocTools } from './skill-tools.js'
import { buildAllTools, buildReadTools } from './tools.js'

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
  toolScope?: 'all' | 'read-only'
  /** Seed initial transcript. Used by the registry when rehydrating a persisted session. */
  initialMessages?: import('@mariozechner/pi-agent-core').AgentMessage[]
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
  if (!fs.existsSync(soulPath)) return skillBody
  const soulBody = fs.readFileSync(soulPath, 'utf-8')
  return `${soulBody.trimEnd()}\n\n---\n\n${skillBody}`
}

function missingProviderMessage(): string {
  const configHints = agentProvidersByPriority().join(', ')
  const envHints = agentProvidersByPriority()
    .map((p) => `${AGENT_PROVIDERS[p].piAiProvider.toUpperCase()}_API_KEY`)
    .join(' / ')
  return (
    `No agent LLM provider configured. Add an API key for one of: ${configHints} in ` +
    `~/.canonry/config.yaml, or export ${envHints}.`
  )
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

export function createAeroSession(opts: AeroSessionOptions): Agent {
  const systemPrompt = opts.systemPromptOverride ?? loadAeroSystemPrompt()

  const provider = opts.provider ?? detectAgentProvider(opts.config)
  if (!provider) throw new Error(missingProviderMessage())

  const model = resolveAeroModel(provider, opts.modelId)

  const toolScope = opts.toolScope ?? 'all'
  // Skill-doc tools ride in both scopes — they're pure reads of bundled
  // assets, no project state involved.
  const stateTools =
    toolScope === 'read-only'
      ? buildReadTools({ client: opts.client, projectName: opts.projectName })
      : buildAllTools({ client: opts.client, projectName: opts.projectName })
  const defaultTools = [...stateTools, ...buildSkillDocTools()]
  const tools = opts.tools ?? defaultTools

  return new Agent({
    initialState: {
      systemPrompt,
      model,
      tools,
      ...(opts.initialMessages ? { messages: opts.initialMessages } : {}),
    },
    streamFn: opts.streamFn,
    getApiKey: buildApiKeyResolver(opts.config),
  })
}

/** Exposed so the registry can persist the chosen provider/model without re-running detection. */
export function resolveSessionProviderAndModel(
  config: CanonryConfig,
  opts?: { provider?: SupportedAgentProvider; modelId?: string },
): { provider: SupportedAgentProvider; modelId: string } {
  const provider = opts?.provider ?? detectAgentProvider(config)
  if (!provider) throw new Error(missingProviderMessage())
  const modelId = opts?.modelId ?? getAgentProvider(provider).defaultModel
  return { provider, modelId }
}
