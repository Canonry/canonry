import type { ProviderAdapter, ProviderQuotaPolicy } from '@ainyc/canonry-contracts'
import type { CanonryConfig } from './config.js'
import { providerConfigFromEntry } from './provider-batch-config.js'
import { isApiProviderRegistrable, isCdpProviderRegistrable } from './provider-registration.js'
import { resolveRegistration, type RegisteredProvider } from './provider-registry.js'

export const DEFAULT_PROVIDER_QUOTA = {
  maxConcurrency: 2,
  maxRequestsPerMinute: 10,
  maxRequestsPerDay: 1000,
}

export const DEFAULT_CDP_QUOTA = {
  maxConcurrency: 1,
  maxRequestsPerMinute: 4,
  maxRequestsPerDay: 200,
}

/**
 * The limits a registration runs with, for every path that registers a
 * provider (startup, reload, settings writes). Each saved limit wins; one the
 * config leaves out (a partial `quota:` block, a blank YAML value, or no block)
 * takes the default. A partial block used to register with missing limits:
 * no per-minute cap and a daily check that refused every run after the first.
 */
export function resolveProviderQuotaPolicy(
  quota: Partial<ProviderQuotaPolicy> | null | undefined,
  defaults: ProviderQuotaPolicy,
): ProviderQuotaPolicy {
  const saved: Partial<ProviderQuotaPolicy> = quota && typeof quota === 'object' && !Array.isArray(quota) ? quota : {}
  return {
    maxConcurrency: saved.maxConcurrency ?? defaults.maxConcurrency,
    maxRequestsPerMinute: saved.maxRequestsPerMinute ?? defaults.maxRequestsPerMinute,
    maxRequestsPerDay: saved.maxRequestsPerDay ?? defaults.maxRequestsPerDay,
  }
}

/**
 * The complete registration set for one config, shared by startup and
 * explicit reload: a config the server boots with reloads to the same
 * registrations. Reload refuses only what loading the config refuses.
 */
export function configuredProviderEntries(
  config: CanonryConfig,
  apiAdapters: readonly ProviderAdapter[],
  cdpAdapter: ProviderAdapter,
): RegisteredProvider[] {
  const registered: RegisteredProvider[] = []
  for (const adapter of apiAdapters) {
    const entry = config.providers?.[adapter.name]
    if (!entry) continue
    if (isApiProviderRegistrable(adapter.name, entry)) {
      registered.push(resolveRegistration(adapter, providerConfigFromEntry(
        adapter.name, entry, resolveProviderQuotaPolicy(entry.quota, DEFAULT_PROVIDER_QUOTA),
      )))
    }
  }
  if (isCdpProviderRegistrable(config.cdp)) {
    registered.push(resolveRegistration(cdpAdapter, {
      provider: cdpAdapter.name,
      cdpEndpoint: `ws://${config.cdp?.host ?? 'localhost'}:${config.cdp?.port ?? 9222}`,
      quotaPolicy: resolveProviderQuotaPolicy(config.cdp?.quota, DEFAULT_CDP_QUOTA),
    }))
  }
  return registered
}
