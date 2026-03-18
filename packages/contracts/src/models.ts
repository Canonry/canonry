import type { ProviderName } from './provider.js'

export interface ModelDefinition {
  /** API model ID (e.g. "gemini-3-flash") */
  id: string
  /** Human-readable display name */
  displayName: string
  /** Capability tier for sorting/display */
  tier: 'flagship' | 'standard' | 'fast' | 'economy'
}

export interface ProviderModelRegistry {
  /** Default model ID used when none is configured */
  defaultModel: string
  /** Regex pattern for validating user-supplied model IDs */
  validationPattern: RegExp
  /** Human-readable description of the naming convention */
  validationHint: string
  /** Known models (not exhaustive — users can specify any valid ID) */
  knownModels: ModelDefinition[]
}

/**
 * Centralized model registry for all providers.
 *
 * This is the single source of truth for default models, validation rules,
 * and known model IDs. Update this file when providers release new models.
 *
 * Last updated: 2026-03-14
 */
export const MODEL_REGISTRY: Record<ProviderName, ProviderModelRegistry> = {
  gemini: {
    defaultModel: 'gemini-3-flash',
    validationPattern: /^gemini-/,
    validationHint: 'model name must start with "gemini-" (e.g. gemini-3-flash)',
    knownModels: [
      { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro (Preview)', tier: 'flagship' },
      { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash (Preview)', tier: 'standard' },
      { id: 'gemini-3.1-flash-lite-preview', displayName: 'Gemini 3.1 Flash-Lite (Preview)', tier: 'economy' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', tier: 'standard' },
    ],
  },
  openai: {
    defaultModel: 'gpt-5.4',
    validationPattern: /^(gpt-|o\d)/,
    validationHint: 'expected a GPT or o-series model name (e.g. gpt-5.4, o3)',
    knownModels: [
      { id: 'gpt-5.4', displayName: 'GPT-5.4', tier: 'flagship' },
      { id: 'gpt-5.4-pro', displayName: 'GPT-5.4 Pro', tier: 'flagship' },
      { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', tier: 'fast' },
      { id: 'gpt-5-nano', displayName: 'GPT-5 Nano', tier: 'economy' },
      { id: 'gpt-5', displayName: 'GPT-5', tier: 'standard' },
      { id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'standard' },
    ],
  },
  claude: {
    defaultModel: 'claude-sonnet-4-6',
    validationPattern: /^claude-/,
    validationHint: 'model name must start with "claude-" (e.g. claude-sonnet-4-6)',
    knownModels: [
      { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tier: 'flagship' },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tier: 'standard' },
      { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', tier: 'fast' },
    ],
  },
  local: {
    defaultModel: 'llama3',
    validationPattern: /./,
    validationHint: 'any model name accepted',
    knownModels: [
      { id: 'llama3', displayName: 'Llama 3', tier: 'standard' },
    ],
  },
  'cdp:chatgpt': {
    defaultModel: 'chatgpt-web',
    validationPattern: /./,
    validationHint: 'model is detected from the ChatGPT web UI',
    knownModels: [
      { id: 'chatgpt-web', displayName: 'ChatGPT (Web UI)', tier: 'standard' },
    ],
  },
}

/** Get the default model ID for a provider */
export function getDefaultModel(provider: ProviderName): string {
  return MODEL_REGISTRY[provider].defaultModel
}

/** Validate a model name against a provider's naming convention */
export function isValidModelName(provider: ProviderName, model: string): boolean {
  return MODEL_REGISTRY[provider].validationPattern.test(model)
}

/** Get known models for a provider, optionally filtered by tier */
export function getKnownModels(provider: ProviderName, tier?: ModelDefinition['tier']): ModelDefinition[] {
  const models = MODEL_REGISTRY[provider].knownModels
  return tier ? models.filter(m => m.tier === tier) : models
}

/** Get an example model string for placeholder/hint text */
export function getModelHint(provider: ProviderName): string {
  return `e.g. ${MODEL_REGISTRY[provider].defaultModel}`
}
