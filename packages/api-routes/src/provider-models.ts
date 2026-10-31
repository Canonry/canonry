import {
  escapeRegExp,
  isProviderAvailable,
  isEligibleFor,
  isSweepProvider,
  resolveProviderModel,
  resolveProviderRoute,
  routeFamiliesOf,
  validationError,
  type ProviderDispatchModesMap,
  type ProviderModels,
  type ProviderRouteFamily,
  type ProviderSelectionMode,
  type ProviderWorkflow,
} from '@canonry/canonry-contracts'
import type { ProviderAdapterInfo } from './settings.js'
import { SETTINGS_WRITE_SCOPE } from './settings.js'
import type { FastifyRequest } from 'fastify'
import { requireScope } from './auth.js'

/** Route families of the host's adapters (OpenRouter is always known). */
export function providerRouteFamilies(adapters: readonly ProviderAdapterInfo[] | undefined): ProviderRouteFamily[] {
  return routeFamiliesOf(adapters)
}

/**
 * A newly selected route picks a model or a paid profile, so it needs the
 * same settings authority as a model override. Saved routes stay usable by
 * the credentials that could already run them.
 */
export function assertProviderRouteScope(
  request: FastifyRequest,
  selected: readonly string[],
  authorized: readonly string[],
  families?: readonly ProviderRouteFamily[],
): void {
  const saved = new Set(authorized.map(name => name.trim().toLowerCase()))
  if (selected.some(name => resolveProviderRoute(name.trim().toLowerCase(), families) && !saved.has(name.trim().toLowerCase()))) {
    requireScope(request, SETTINGS_WRITE_SCOPE)
  }
}

/** @deprecated Use {@link assertProviderRouteScope}; kept for callers that only know OpenRouter. */
export const assertOpenRouterRouteScope = assertProviderRouteScope

/**
 * The provider keys in a selection that cannot run a workflow: not a concrete
 * target (a bare routed connection, a malformed route), not configured on
 * this host, or (for an answer service) a profile that does not declare the
 * workflow. Explicit selection only; implicit defaults never reach here.
 */
export function invalidProviderSelections(
  names: readonly string[],
  available: readonly string[],
  adapters: readonly ProviderAdapterInfo[] | undefined,
  workflow: ProviderWorkflow,
): string[] {
  const families = providerRouteFamilies(adapters)
  return names.filter(name => {
    if (!isSweepProvider(name, families) || !isProviderAvailable(name, available, families)) return true
    const adapter = adapters ? providerAdapterForName(name, adapters) : undefined
    return adapter !== undefined && !isEligibleFor(adapter, workflow, 'explicit')
  })
}

/** Whether an adapter description may run a workflow under a selection mode. */
export function providerEligibleFor(
  name: string,
  adapters: readonly ProviderAdapterInfo[] | undefined,
  workflow: ProviderWorkflow,
  selection: ProviderSelectionMode,
): boolean {
  const families = providerRouteFamilies(adapters)
  if (!isSweepProvider(name, families)) return false
  const adapter = adapters ? providerAdapterForName(name, adapters) : undefined
  return adapter === undefined ? selection === 'explicit' : isEligibleFor(adapter, workflow, selection)
}

/** The selection (model or profile) a route key pins, or undefined for any other key. */
export function pinnedRouteSelection(name: string, families?: readonly ProviderRouteFamily[]): string | undefined {
  return resolveProviderRoute(name, families)?.selection
}

/** Resolve a route key using its connection's adapter metadata. */
export function providerAdapterForName(name: string, adapters: readonly ProviderAdapterInfo[]): ProviderAdapterInfo | undefined {
  const direct = adapters.find(adapter => adapter.name === name)
  if (direct) return direct
  const route = resolveProviderRoute(name, providerRouteFamilies(adapters))
  const connection = route && adapters.find(adapter => adapter.name === route.connection)
  if (!connection || !route) return undefined
  if (route.family.selectionKind === 'profile') {
    const profile = connection.profiles?.find(item => item.id === route.selection)
    if (!profile) return undefined
    return {
      ...connection,
      name,
      displayName: `${profile.displayName} · ${connection.displayName}`,
      modelConfigurable: false,
      defaultModel: profile.id,
      knownModels: [{ id: profile.id, displayName: profile.displayName, tier: 'standard' }],
      modelValidationPattern: new RegExp(`^${escapeRegExp(profile.id)}$`),
      modelValidationHint: `The ${connection.displayName} route pins its profile; select another route to change it.`,
      capabilities: { textGeneration: false, groundedAnswer: true, workflows: [...profile.workflows] },
      profiles: [profile],
    }
  }
  const model = route.selection
  connection.modelValidationPattern.lastIndex = 0
  if (!connection.modelValidationPattern.test(model)) return undefined
  const known = connection.knownModels.find(entry => entry.id === model)
  return {
    ...connection,
    name,
    displayName: `${known?.displayName ?? model} via ${connection.displayName}`,
    modelConfigurable: false,
    defaultModel: model,
    knownModels: known ? [known] : [],
    modelValidationHint: `The ${connection.displayName} route pins its model; select another route to change it.`,
  }
}

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

  const normalized: ProviderModels = {}
  for (const [provider, rawModel] of entries) {
    const adapter = providerAdapterForName(provider, adapters)
    if (!adapter) {
      throw validationError(`Invalid provider model override: unknown provider "${provider}".`, {
        provider,
        validProviders: adapters.map(item => item.name),
      })
    }
    const route = resolveProviderRoute(provider, providerRouteFamilies(adapters))
    const pinned = route?.selection
    if (pinned && rawModel.trim() !== pinned) {
      const connection = adapters.find(item => item.name === route.connection)?.displayName ?? route.connection
      throw validationError(`${connection} route "${provider}" pins ${route.family.selectionKind} "${pinned}". Select another route to change it.`, { provider, model: rawModel, pinnedModel: pinned })
    }
    if (!adapter.modelConfigurable && !pinned) {
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
    // Store the id that answers, not a retired alias of it (Perplexity's
    // `sonar-pro` is stored as `low`), so every reader sees the engine that runs.
    normalized[provider] = resolveProviderModel(provider, model)
  }
  return normalized
}

/**
 * Validate a project's dispatch preference the way model overrides are: every
 * key must name a provider the host has a descriptor for, and a deployment with
 * no descriptor catalog refuses a non-empty map rather than storing names
 * nothing checked. Values are already `sync` / `batch` by schema. Whether the
 * instance can actually batch a provider is decided per run, not here: a
 * preference may be stored before the operator enables batch in config.yaml.
 */
export function validateProviderDispatchModes(
  modes: ProviderDispatchModesMap,
  adapters: readonly ProviderAdapterInfo[] | undefined,
): ProviderDispatchModesMap {
  const entries = Object.entries(modes)
  if (entries.length === 0) return {}
  if (!adapters || adapters.length === 0) {
    throw validationError('Project dispatch modes are unavailable because provider metadata is not configured.')
  }
  const normalized: ProviderDispatchModesMap = {}
  for (const [provider, mode] of entries) {
    if (!providerAdapterForName(provider, adapters)) {
      throw validationError(`Invalid provider dispatch mode: unknown provider "${provider}".`, {
        provider,
        validProviders: adapters.map(item => item.name),
      })
    }
    normalized[provider] = mode
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
 *
 * `providerDispatchModes` is pruned by the same rule, for the same reason,
 * through `pruneProviderDispatchModes`.
 */
export function pruneProviderModelsForProviders<T extends string>(
  models: Readonly<Record<string, T>>,
  providers: readonly string[],
): Record<string, T> {
  if (providers.length === 0) return { ...models }
  const kept: Record<string, T> = {}
  for (const [provider, model] of Object.entries(models)) {
    if (providers.includes(provider)) kept[provider] = model
  }
  return kept
}

/**
 * A dispatch preference is kept for every engine the project's runs measure,
 * which for a simple portfolio is its provider list and for an Advanced one
 * also includes the engines its active revision froze (`revisionProviders`, see
 * `activeRevisionProviders`). A v2 run measures those whatever the project row
 * lists, so pruning against the row alone would silently drop, or refuse to
 * store, a preference its scheduled sweeps still honour. An empty provider
 * list keeps everything, as for model overrides.
 */
export function pruneProviderDispatchModes(
  modes: Readonly<ProviderDispatchModesMap>,
  providers: readonly string[],
  revisionProviders: readonly string[],
): ProviderDispatchModesMap {
  if (providers.length === 0) return { ...modes }
  return pruneProviderModelsForProviders(modes, [...providers, ...revisionProviders])
}
