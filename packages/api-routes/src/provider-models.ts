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

/**
 * A model override only means something for an engine the project actually
 * runs. An override for an unselected engine is inert but stored, and it
 * silently takes effect the day that engine is added back — so reject it at the
 * boundary rather than stripping it: `apply` is expected to be idempotent, and
 * quietly dropping an operator-supplied key would make its output diverge from
 * its input with nothing said.
 *
 * An EMPTY provider list means "every configured engine" (both routes persist
 * `providers ?? []` and read it that way), so nothing is orphaned there and
 * every override is kept.
 */
export function assertProviderModelsMatchProviders(
  models: ProviderModels,
  providers: readonly string[],
): void {
  if (providers.length === 0) return
  const orphaned = Object.keys(models).filter(provider => !providers.includes(provider))
  if (orphaned.length === 0) return
  throw validationError(
    `Model override set for provider(s) the project does not run: ${orphaned.join(', ')}. Add them to "providers" or drop the override.`,
    { orphanedProviders: orphaned, providers: [...providers] },
  )
}
