/** Prices a provider catalog publishes for one model, in US dollars per million tokens. */
export interface ModelPricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ModelDefinition {
  /** API model ID (e.g. "gemini-2.5-flash") */
  id: string
  /** Human-readable display name */
  displayName: string
  /** Capability tier for sorting/display */
  tier: 'flagship' | 'standard' | 'fast' | 'economy'
  // Optional metadata read from the same live catalog response as the entry.
  // Aero builds a model it has no bundled definition for from these. Picker
  // DTOs (`GET /settings`, research) carry only id, name and tier.
  /** Context window in tokens. */
  contextWindow?: number
  /** Largest completion the provider allows, in tokens. */
  maxOutputTokens?: number
  pricing?: ModelPricing
  /** Input kinds the model accepts, as the catalog names them (`text`, `image`, `file`, ...). */
  inputModalities?: string[]
  /** Whether the model accepts tool definitions; absent when the catalog does not say. */
  supportsTools?: boolean
  /** Whether the model takes reasoning controls; absent when the catalog does not say. */
  supportsReasoning?: boolean
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

/** A readable label only; never use it as a model's execution or filter identity. */
export function formatModelName(
  id: string,
  knownModels: readonly Pick<ModelDefinition, 'id' | 'displayName'>[] = [],
): string {
  const parts = id.trim().split('/')
  const publisher = parts.length > 1 ? parts.shift()! : ''
  const model = parts.join('/')
  const redundantPublisher = publisher === 'google' && /^gemini(?:[-_]|$)/i.test(model) ? 'Google'
    : publisher === 'anthropic' && /^claude(?:[-_]|$)/i.test(model) ? 'Anthropic'
      : publisher === 'openai' && /^(?:gpt(?:[-_]|$)|o\d)/i.test(model) ? 'OpenAI' : ''
  const known = knownModels.find(entry => entry.id === id)?.displayName.trim()
  if (known) {
    const prefix = `${redundantPublisher}:`
    return redundantPublisher && known.startsWith(prefix) ? known.slice(prefix.length).trim() || known : known
  }
  const words = (slug: string) => slug
    // Numeric separators identify versions and dates; do not turn 4-5 into 4.5.
    .replace(/(?<!\d)[-_]|[-_](?!\d)/g, ' ')
    .replace(/:\s*/g, ': ')
    .replace(/\b[a-z]+/gi, word => word.toLowerCase() === 'gpt' ? 'GPT'
      : word.toLowerCase() === 'ai' ? 'AI'
        : word === 'o' ? word : word.charAt(0).toUpperCase() + word.slice(1))
    .replace(/\bGPT (?=\d)/g, 'GPT-')
  const label = words(model)
  return publisher && !redundantPublisher ? `${words(publisher)}: ${label}` : label
}

/**
 * Model ids a provider renamed or retired, mapped to the id that answers in
 * their place. Keyed by provider name.
 *
 * Perplexity retired Sonar Chat Completions on 2026-09-27 and moved to the
 * Agent API, which takes a preset (or a `vendor/model` slug) instead of a Sonar
 * model name. The mapping is Perplexity's own migration table
 * (https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar):
 * `sonar` → `fast`, `sonar-pro` / `sonar-reasoning` / `sonar-reasoning-pro` →
 * `low`, `sonar-deep-research` → `medium`. The long preset names are the
 * previous names of the short ones and are folded in too, so the two spellings
 * of one preset never read as two different engines.
 *
 * Resolving here, rather than inside the adapter only, is what keeps
 * comparability honest: an install whose config still says `sonar` gets an
 * execution identity naming `fast`, so the engine switch starts a new series
 * instead of passing as the same measurement.
 */
export const PROVIDER_MODEL_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  perplexity: {
    sonar: 'fast',
    'sonar-pro': 'low',
    'sonar-reasoning': 'low',
    'sonar-reasoning-pro': 'low',
    'sonar-deep-research': 'medium',
    'fast-search': 'fast',
    'pro-search': 'low',
    'deep-research': 'medium',
    'advanced-deep-research': 'high',
  },
}

/**
 * The model id that actually answers for `model` on `provider`: its
 * replacement when the provider renamed or retired it, otherwise `model`
 * unchanged. Pure lookup — no trimming, no case folding.
 */
export function resolveProviderModel(provider: string, model: string): string {
  const aliases = PROVIDER_MODEL_ALIASES[provider]
  return aliases !== undefined && Object.hasOwn(aliases, model) ? aliases[model]! : model
}
