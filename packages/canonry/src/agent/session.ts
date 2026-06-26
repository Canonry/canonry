import fs from 'node:fs'
import path from 'node:path'
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentOptions, AgentTool } from '@mariozechner/pi-agent-core'
import { registerBuiltInApiProviders, type Model } from '@mariozechner/pi-ai'
import type { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import {
  agentProviderApiKeyEnvVar,
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
  const base = fs.existsSync(soulPath)
    ? `${fs.readFileSync(soulPath, 'utf-8').trimEnd()}\n\n---\n\n${skillBody}`
    : skillBody
  return appendSystemPromptExtras(base)
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
  const toolCtx = {
    client: opts.client,
    projectName: opts.projectName,
  }
  // Skill-doc tools ride in both scopes — they're pure reads of bundled
  // assets, no project state involved.
  const stateTools = toolScope === 'read-only' ? buildReadTools(toolCtx) : buildAllTools(toolCtx)
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
