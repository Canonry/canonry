import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

export function loadAeroSystemPrompt(pkgDir?: string): string {
  const here = pkgDir ?? path.dirname(fileURLToPath(import.meta.url))
  // Search order reflects how canonry is packaged vs. run in-repo:
  //   prod  : packages/canonry/dist/<flat bundle> → ../assets/agent-workspace/skills/aero/SKILL.md
  //   dev   : packages/canonry/src/agent/session.ts → ../../assets/agent-workspace/skills/aero/SKILL.md
  //   repo  : packages/canonry/src/agent/session.ts → ../../../../skills/aero/SKILL.md
  const candidates = [
    path.join(here, '../assets/agent-workspace/skills/aero/SKILL.md'),
    path.join(here, '../../assets/agent-workspace/skills/aero/SKILL.md'),
    path.join(here, '../../../../skills/aero/SKILL.md'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf-8')
    }
  }
  throw new Error(`Aero skill not found. Searched:\n  ${candidates.join('\n  ')}`)
}

function missingProviderMessage(): string {
  const configHints = agentProvidersByPriority()
    .map((p) => AGENT_PROVIDERS[p].canonryConfigKey)
    .join(', ')
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
  const defaultTools =
    toolScope === 'read-only'
      ? buildReadTools({ client: opts.client, projectName: opts.projectName })
      : buildAllTools({ client: opts.client, projectName: opts.projectName })
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
