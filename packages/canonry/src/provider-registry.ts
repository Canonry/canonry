import type { ProviderAdapter, ProviderConfig, ProviderName, ProviderHealthcheckResult, ProviderRouteFamily, ProviderWorkflow, ResolvedProviderRoute } from '@canonry/canonry-contracts'
import { adapterConnectionName, isBrowserProvider, isEligibleFor, isSweepProvider, ProviderWorkflows, resolveProviderModel, resolveProviderRoute, routeFamiliesOf } from '@canonry/canonry-contracts'
import { updateSharedProviderExecutionGate } from './provider-execution-gate.js'

export interface RegisteredProvider {
  adapter: ProviderAdapter
  config: ProviderConfig
}

export function resolveRegistration(adapter: ProviderAdapter, config: ProviderConfig): RegisteredProvider {
  // Store the model that actually answers when a configured id was retired.
  return {
    adapter,
    config: config.model === undefined ? config : { ...config, model: resolveProviderModel(adapter.name, config.model) },
  }
}

export class ProviderRegistry {
  private providers = new Map<ProviderName, RegisteredProvider>()

  register(adapter: ProviderAdapter, config: ProviderConfig): void {
    const provider = resolveRegistration(adapter, config)
    this.providers.set(adapter.name, provider)
    updateSharedProviderExecutionGate(adapter.name, provider.config.quotaPolicy.maxConcurrency, provider.config.quotaPolicy.maxRequestsPerMinute)
  }

  /** Publish a complete registration set without mutating configs captured by active runs. */
  replace(providers: readonly RegisteredProvider[]): void {
    const next = new Map<ProviderName, RegisteredProvider>()
    for (const { adapter, config } of providers) {
      next.set(adapter.name, resolveRegistration(adapter, config))
    }
    this.providers = next
    for (const { adapter, config } of next.values()) {
      updateSharedProviderExecutionGate(adapter.name, config.quotaPolicy.maxConcurrency, config.quotaPolicy.maxRequestsPerMinute)
    }
  }

  /**
   * A registered provider, or the registration a route key runs as: the
   * route's connection supplies the key, quota and gate, and its selection
   * is pinned as the model.
   */
  get(name: ProviderName): RegisteredProvider | undefined {
    const registered = this.providers.get(name)
    if (registered) return registered
    const route = resolveProviderRoute(name, this.routeFamilies())
    const connection = route ? this.providers.get(route.connection) : undefined
    if (!connection || !route) return undefined
    return {
      config: { ...connection.config, provider: name, model: route.selection },
      adapter: connection.adapter.forRoute ? connection.adapter.forRoute(route) : derivedRouteAdapter(connection.adapter, route),
    }
  }

  /** Route families of the registered connections (OpenRouter is always known). */
  routeFamilies(): ProviderRouteFamily[] {
    return routeFamiliesOf(this.getAll().map(provider => provider.adapter))
  }

  /** The connection that owns a provider key's credentials, quota and gate. */
  connectionOf(name: ProviderName): string {
    const provider = this.get(name)
    return provider ? adapterConnectionName(provider.adapter) : name
  }

  getAll(): RegisteredProvider[] {
    return [...this.providers.values()]
  }

  /**
   * The engines a project's sweep runs. An empty list means every configured
   * answer engine, and nothing else: a gateway or a hosted answer service is
   * only ever measured when a project names one of its routes.
   */
  getForProject(projectProviders: ProviderName[], workflow: ProviderWorkflow = ProviderWorkflows['visibility-sweep']): RegisteredProvider[] {
    const families = this.routeFamilies()
    if (projectProviders.length === 0) {
      return this.getAll().filter(provider => isSweepProvider(provider.adapter.name, families) && isEligibleFor(provider.adapter, workflow, 'implicit'))
    }
    const result: RegisteredProvider[] = []
    const seen = new Set<ProviderName>()
    for (const name of projectProviders) {
      if (seen.has(name)) continue
      seen.add(name)
      const provider = this.get(name)
      if (provider && isSweepProvider(provider.adapter.name, families) && isEligibleFor(provider.adapter, workflow, 'explicit')) {
        result.push(provider)
      }
    }
    return result
  }

  /** Get only browser-based (CDP) providers */
  getBrowserProviders(): RegisteredProvider[] {
    return this.getAll().filter(p => isBrowserProvider(p.adapter.name))
  }

  /** Configured API answer engines (the implicit set; routed connections are excluded). */
  getApiProviders(): RegisteredProvider[] {
    const families = this.routeFamilies()
    return this.getAll().filter(p => !isBrowserProvider(p.adapter.name) && isSweepProvider(p.adapter.name, families) && isEligibleFor(p.adapter, ProviderWorkflows['visibility-sweep'], 'implicit'))
  }

  get size(): number {
    return this.providers.size
  }

  async healthcheckAll(): Promise<Map<ProviderName, ProviderHealthcheckResult>> {
    const results = new Map<ProviderName, ProviderHealthcheckResult>()
    const entries = [...this.providers.entries()]
    const checks = entries.map(async ([name, { adapter, config }]) => {
      const result = await adapter.healthcheck(config)
      results.set(name, result)
    })
    await Promise.all(checks)
    return results
  }
}

/** A model route's adapter: the connection's own, named for the route, with the model pinned. */
function derivedRouteAdapter(adapter: ProviderAdapter, route: ResolvedProviderRoute): ProviderAdapter {
  return {
    ...adapter,
    name: route.name,
    displayName: `${route.selection} · ${adapter.displayName}`,
    modelRegistry: { ...adapter.modelRegistry, defaultModel: route.selection },
    parseTrackedQueryResponse: adapter.parseTrackedQueryResponse
      ? (body, requestedModel) => ({ ...adapter.parseTrackedQueryResponse!(body, requestedModel), provider: route.name })
      : undefined,
  }
}
