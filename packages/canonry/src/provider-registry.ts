import type { ProviderAdapter, ProviderConfig, ProviderName, ProviderHealthcheckResult } from '@ainyc/canonry-contracts'
import { isBrowserProvider } from '@ainyc/canonry-contracts'

export interface RegisteredProvider {
  adapter: ProviderAdapter
  config: ProviderConfig
}

export class ProviderRegistry {
  private providers = new Map<ProviderName, RegisteredProvider>()

  register(adapter: ProviderAdapter, config: ProviderConfig): void {
    this.providers.set(adapter.name, { adapter, config })
  }

  get(name: ProviderName): RegisteredProvider | undefined {
    return this.providers.get(name)
  }

  getAll(): RegisteredProvider[] {
    return [...this.providers.values()]
  }

  /** Text-only routes are registered for internal LLM work but never sweeps. */
  getMeasurableAll(): RegisteredProvider[] {
    return this.getAll().filter(provider => provider.config.measurementReady !== false)
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

  getMeasurableForProject(projectProviders: ProviderName[]): RegisteredProvider[] {
    return this.getForProject(projectProviders).filter(provider => provider.config.measurementReady !== false)
  }

  isMeasurementReady(name: ProviderName): boolean {
    // Unknown is never permission to measure. Native registrations omit the
    // flag for backward compatibility, but a missing registration has no
    // server-owned evidence adapter to prove a sweep.
    const provider = this.providers.get(name)
    return provider !== undefined && provider.config.measurementReady !== false
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
