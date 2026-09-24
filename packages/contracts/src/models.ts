export interface ModelDefinition {
  /** API model ID (e.g. "gemini-2.5-flash") */
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
