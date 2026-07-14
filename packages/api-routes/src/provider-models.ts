import { validationError, type ProviderModels } from '@ainyc/canonry-contracts'
import type { ProviderAdapterInfo } from './settings.js'

/**
 * Validate project model overrides against the descriptors supplied by the
 * host. This intentionally fails closed when a deployment has no descriptor
 * catalog: accepting an unvalidated override would make Cloud and local serve
 * disagree about what actually runs.
 */
export function validateProviderModels(
  models: ProviderModels,
  adapters: readonly ProviderAdapterInfo[] | undefined,
): ProviderModels {
  const entries = Object.entries(models)
  if (entries.length === 0) return {}
  if (!adapters || adapters.length === 0) {
    throw validationError('Project model overrides are unavailable because provider metadata is not configured.')
  }

  const byName = new Map(adapters.map(adapter => [adapter.name, adapter]))
  const normalized: ProviderModels = {}
  for (const [provider, rawModel] of entries) {
    const adapter = byName.get(provider)
    if (!adapter) {
      throw validationError(`Invalid provider model override: unknown provider "${provider}".`, {
        provider,
        validProviders: adapters.map(item => item.name),
      })
    }
    if (!adapter.modelConfigurable) {
      throw validationError(`Provider "${provider}" does not support project model overrides.`, {
        provider,
        modelConfigurable: false,
      })
    }
    const model = rawModel.trim()
    if (!model) {
      throw validationError(`Model override for provider "${provider}" must not be blank.`)
    }
    // Reset lastIndex in case a future adapter owns a global/sticky regex.
    adapter.modelValidationPattern.lastIndex = 0
    if (!adapter.modelValidationPattern.test(model)) {
      throw validationError(
        `Invalid model "${model}" for provider "${provider}" — ${adapter.modelValidationHint}`,
        { provider, model, hint: adapter.modelValidationHint },
      )
    }
    normalized[provider] = model
  }
  return normalized
}
