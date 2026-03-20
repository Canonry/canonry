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
