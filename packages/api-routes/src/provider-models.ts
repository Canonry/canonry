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
 * silently takes effect the day that engine is added back — so it must not be
 * persisted. Both write paths (`PUT /projects/:name`, `POST /apply`) are FULL
 * REPLACE, so the pruning happens SERVER-SIDE rather than at the boundary: the
 * caller echoes the project's stored map back on every unrelated edit, and a
 * boundary rejection would make narrowing the engine set impossible for any
 * project (or `apply` file) that carries an override for a dropped engine —
 * the client is told to drop the key, and dropping it is a change to the map.
 *
 * The prune is not silent. Both routes return the stored `providerModels` in
 * their response, so the caller sees the persisted map; `canonry project
 * update` diffs what it sent against what came back and names the drop.
 * `apply` stays idempotent: applying a file whose overrides include a
 * deselected engine converges on the pruned map and reapplying is a no-op.
 *
 * An EMPTY provider list means "every configured engine" (both routes persist
 * `providers ?? []` and read it that way), so nothing is orphaned there and
 * every override is kept.
 */
export function pruneProviderModelsForProviders(
  models: ProviderModels,
  providers: readonly string[],
): ProviderModels {
  if (providers.length === 0) return { ...models }
  const kept: ProviderModels = {}
  for (const [provider, model] of Object.entries(models)) {
    if (providers.includes(provider)) kept[provider] = model
  }
  return kept
}
