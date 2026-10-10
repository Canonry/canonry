import type { ProviderAdapter, ProviderConfig, ProviderName, ProviderHealthcheckResult } from '@ainyc/canonry-contracts'
import { isBrowserProvider, resolveProviderModel } from '@ainyc/canonry-contracts'
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

  get(name: ProviderName): RegisteredProvider | undefined {
    return this.providers.get(name)
  }

  getAll(): RegisteredProvider[] {
    return [...this.providers.values()]
  }

  getForProject(projectProviders: ProviderName[]): RegisteredProvider[] {
    // Empty array means "use all configured providers"
    if (projectProviders.length === 0) {
      return this.getAll()
    }
    const result: RegisteredProvider[] = []
    const seen = new Set<ProviderName>()
    for (const name of projectProviders) {
      if (seen.has(name)) continue
      seen.add(name)
      const provider = this.providers.get(name)
      if (provider) {
        result.push(provider)
      }
    }
    return result
  }

  /** Get only browser-based (CDP) providers */
  getBrowserProviders(): RegisteredProvider[] {
    return this.getAll().filter(p => isBrowserProvider(p.adapter.name))
  }

  /** Get only API-based providers */
  getApiProviders(): RegisteredProvider[] {
    return this.getAll().filter(p => !isBrowserProvider(p.adapter.name))
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
