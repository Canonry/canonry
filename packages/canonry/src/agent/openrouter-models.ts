import {
  isModelType,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
} from '@earendil-works/pi-ai'
import { OPENROUTER_MODEL_PATTERN, ProviderIds, type ModelDefinition } from '@canonry/canonry-contracts'

/**
 * Where Aero's OpenRouter models come from: the catalog Canonry already
 * fetches and caches for sweeps (`provider-model-catalog.ts`), so Aero,
 * analysis and classification see the same list the sweep picker shows.
 */
export interface OpenRouterModelSource {
  /** The shared catalog read. It fetches only once the cached list has expired. */
  read(): Promise<readonly ModelDefinition[]>
  /** The cached list. Never fetches. */
  cached(): readonly ModelDefinition[]
}

export interface AgentModelChoice {
  id: string
  displayName: string
}

export interface OpenRouterModelCatalog {
  /** Follow `source`. Returns a function that stops following it. */
  connect(source: OpenRouterModelSource): () => void
  /**
   * Bring pi's OpenRouter list up to date with the shared catalog. Fetches
   * only when the shared catalog's cached list has expired, so calling this
   * before every turn costs no request.
   */
  refresh(signal?: AbortSignal): Promise<void>
  /**
   * The models Aero can run: live entries that support tool calling, or pi's
   * bundled list while no live list is loaded.
   */
  agentModels(): AgentModelChoice[]
  /** Whether a live list is loaded. */
  hasLiveList(): boolean
}

/** The API pi's OpenRouter provider uses for every model it does not route through Anthropic's. */
const COMPLETIONS_API = 'openai-completions'

function newestFirst(a: { id: string }, b: { id: string }): number {
  return b.id.localeCompare(a.id, 'en', { numeric: true })
}

/**
 * Replace pi's built-in, fixed OpenRouter provider in `models` with one whose
 * chat models follow Canonry's shared OpenRouter catalog.
 *
 * pi-ai ships OpenRouter as a static list, so a model released after the
 * installed pi-ai version would need a code change. The replacement keeps
 * pi's auth, streaming, image and classifier transports and its bundled
 * models (their metadata carries request settings pi tuned per model), and
 * adds every live model the bundled list lacks, built from the catalog entry
 * with the API and base URL pi uses for its OpenAI-compatible OpenRouter
 * models. Its list changes only through `refreshModels`, as pi's dynamic
 * providers do. While the catalog cannot be read, the bundled list is all
 * there is, so Aero keeps working offline.
 */
export function installOpenRouterModelCatalog(models: MutableModels): OpenRouterModelCatalog {
  const builtin = models.getProvider(ProviderIds.openrouter)
  if (!builtin) throw new Error('pi-ai has no built-in OpenRouter provider to replace.')
  const base: Provider = builtin
  const bundled = base.getModels()
  const bundledIds = new Set(bundled.map(model => model.id))
  const completionsUrl = bundled.find(model => model.api === COMPLETIONS_API)?.baseUrl ?? base.baseUrl
  if (!completionsUrl) throw new Error('pi-ai\'s OpenRouter provider names no base URL for its completions API.')
  const baseUrl: string = completionsUrl

  let source: OpenRouterModelSource | undefined
  // The catalog snapshot the list was last built from; the shared catalog
  // hands back the same array until it refetches, so an unchanged list is
  // never rebuilt.
  let applied: readonly ModelDefinition[] | undefined
  let live: readonly ModelDefinition[] = []
  let chatModels: readonly Model<Api>[] = bundled

  function catalogModel(definition: ModelDefinition): Model<typeof COMPLETIONS_API> | undefined {
    // pi needs a context window; OpenRouter publishes one for every model.
    if (!definition.contextWindow) return undefined
    const pricing = definition.pricing
    const reasoning = definition.supportsReasoning === true
    return {
      type: 'chat',
      id: definition.id,
      name: definition.displayName,
      api: COMPLETIONS_API,
      provider: base.id,
      baseUrl,
      reasoning,
      // With thinking off, pi's OpenRouter request sends `reasoning: {effort:
      // "none"}` unless the model maps `off` to null. Null sends no reasoning
      // field, so OpenRouter applies the model's own default, as it does for
      // pi's bundled reasoning models that map `off` to null.
      ...(reasoning ? { thinkingLevelMap: { off: null } } : {}),
      input: definition.inputModalities?.includes('image') ? ['text', 'image'] : ['text'],
      cost: {
        input: pricing?.input ?? 0,
        output: pricing?.output ?? 0,
        cacheRead: pricing?.cacheRead ?? 0,
        cacheWrite: pricing?.cacheWrite ?? 0,
      },
      contextWindow: definition.contextWindow,
      // No separate output cap published: the context window is the only bound.
      maxTokens: definition.maxOutputTokens ?? definition.contextWindow,
    }
  }

  const provider: Provider = {
    id: base.id,
    name: base.name,
    baseUrl: base.baseUrl,
    headers: base.headers,
    auth: base.auth,
    getModels: () => chatModels,
    getAllModels: () => [
      ...chatModels,
      ...(base.getAllModels?.() ?? []).filter(model => !isModelType(model, 'chat')),
    ],
    async refreshModels(context) {
      const current = source
      if (!current) return
      const definitions = context.allowNetwork ? await current.read() : current.cached()
      if (context.signal.aborted || current !== source || definitions === applied) return
      const next = [
        ...bundled,
        ...definitions.flatMap(definition => {
          if (bundledIds.has(definition.id)) return []
          const model = catalogModel(definition)
          return model ? [model] : []
        }),
      ]
      await context.publish({
        update: () => {
          applied = definitions
          live = definitions
          chatModels = next
        },
      })
    },
    filterModels: base.filterModels ? (list, credential) => base.filterModels!(list, credential) : undefined,
    filterAllModels: base.filterAllModels ? (list, credential) => base.filterAllModels!(list, credential) : undefined,
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
    fetchDeferred: base.fetchDeferred ? (model, handle, options) => base.fetchDeferred!(model, handle, options) : undefined,
    cancelDeferred: base.cancelDeferred ? (model, handle, options) => base.cancelDeferred!(model, handle, options) : undefined,
    generateImages: base.generateImages ? (model, context, options) => base.generateImages!(model, context, options) : undefined,
    classify: base.classify ? (model, context, options) => base.classify!(model, context, options) : undefined,
  }
  models.setProvider(provider)

  function reset(): void {
    applied = undefined
    live = []
    chatModels = bundled
    // Supersedes a refresh still reading the previous source.
    models.setProvider(provider)
  }

  return {
    connect(next) {
      source = next
      reset()
      return () => {
        if (source !== next) return
        source = undefined
        reset()
      }
    },
    async refresh(signal) {
      const current = source
      if (!current) return
      try {
        await current.read()
      } catch {
        // The shared catalog keeps its last good list; the bundled one stands in for none.
      }
      // The catalog was just read, so pi's refresh takes its cached list
      // rather than reaching the network again.
      await models.refresh({ providers: [provider.id], allowNetwork: false, signal })
    },
    agentModels() {
      if (live.length > 0) {
        const runnable = new Set(chatModels.map(model => model.id))
        return live
          .filter(definition => definition.supportsTools === true && runnable.has(definition.id))
          .map(({ id, displayName }) => ({ id, displayName }))
      }
      // pi's bundled list carries no tool flag, so every bundled chat model is
      // offered, minus batch routing and unversioned `~` aliases.
      return bundled
        .filter(model => OPENROUTER_MODEL_PATTERN.test(model.id) && !model.id.endsWith(':batch'))
        .map(({ id, name }) => ({ id, displayName: name }))
        .sort(newestFirst)
    },
    hasLiveList: () => live.length > 0,
  }
}
