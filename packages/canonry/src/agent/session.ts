import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentOptions, AgentTool } from '@mariozechner/pi-agent-core'
import { getModel, registerBuiltInApiProviders } from '@mariozechner/pi-ai'
import type { Model } from '@mariozechner/pi-ai'
import type { ApiClient } from '../client.js'
import type { CanonryConfig } from '../config.js'
import { buildReadTools } from './tools.js'

let builtinsRegistered = false
function ensureBuiltinsRegistered(): void {
  if (!builtinsRegistered) {
    registerBuiltInApiProviders()
    builtinsRegistered = true
  }
}

export type SupportedAgentProvider = 'anthropic' | 'openai' | 'google'

const DEFAULT_MODEL_IDS: Record<SupportedAgentProvider, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-5.1',
  google: 'gemini-2.5-pro',
}

/** Canonry config keys for each pi-ai provider. */
const CANONRY_PROVIDER_KEY: Record<SupportedAgentProvider, string> = {
  anthropic: 'claude',
  openai: 'openai',
  google: 'gemini',
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
  /** Override tool set. Default: `buildReadTools({ client, projectName })`. */
  tools?: AgentTool[]
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

/** Pick the first configured pi-ai provider based on available API keys. */
export function detectAgentProvider(config: CanonryConfig): SupportedAgentProvider | undefined {
  const order: SupportedAgentProvider[] = ['anthropic', 'openai', 'google']
  for (const provider of order) {
    const configKey = CANONRY_PROVIDER_KEY[provider]
    if (config.providers?.[configKey]?.apiKey) return provider
  }
  return undefined
}

export function resolveAeroModel(
  provider: SupportedAgentProvider,
  modelId?: string,
): Model<never> {
  ensureBuiltinsRegistered()
  const id = modelId ?? DEFAULT_MODEL_IDS[provider]
  return getModel(provider as never, id as never) as Model<never>
}

/** Resolver used by pi's `getApiKey` callback — maps pi-ai provider → canonry config key → API key. */
export function buildApiKeyResolver(config: CanonryConfig): (provider: string) => string | undefined {
  return (provider: string): string | undefined => {
    const canonryKey = (CANONRY_PROVIDER_KEY as Record<string, string | undefined>)[provider] ?? provider
    return config.providers?.[canonryKey]?.apiKey
  }
}

export function createAeroSession(opts: AeroSessionOptions): Agent {
  const systemPrompt = opts.systemPromptOverride ?? loadAeroSystemPrompt()

  const provider = opts.provider ?? detectAgentProvider(opts.config)
  if (!provider) {
    throw new Error(
      'No agent LLM provider configured. Add an API key for one of: claude, openai, gemini in ~/.canonry/config.yaml.',
    )
  }

  const model = resolveAeroModel(provider, opts.modelId)

  const tools =
    opts.tools ?? buildReadTools({ client: opts.client, projectName: opts.projectName })

  return new Agent({
    initialState: { systemPrompt, model, tools },
    streamFn: opts.streamFn,
    getApiKey: buildApiKeyResolver(opts.config),
  })
}
