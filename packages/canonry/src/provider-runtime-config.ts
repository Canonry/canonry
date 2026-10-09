import { z } from 'zod'
import {
  providerQuotaPolicySchema,
  providerBatchConfigSchema,
  providerPricingSchema,
  validationError,
  type ProviderAdapter,
} from '@ainyc/canonry-contracts'
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

const providerEntrySchema = z.object({
  apiKey: z.string().nullish(),
  baseUrl: z.string().nullish(),
  model: z.string().nullish(),
  quota: providerQuotaPolicySchema.nullish(),
  batch: providerBatchConfigSchema.nullish(),
  pricing: providerPricingSchema.nullish(),
  vertexProject: z.string().nullish(),
  vertexRegion: z.string().nullish(),
  vertexCredentials: z.string().nullish(),
}).passthrough()

const reloadConfigSchema = z.object({
  providers: z.record(z.string(), providerEntrySchema.nullish()).nullish(),
  cdp: z.object({
    host: z.string().nullish(),
    port: z.number().int().min(1).max(65535).nullish(),
    quota: providerQuotaPolicySchema.nullish(),
  }).passthrough().nullish(),
}).passthrough()

/** Refuse malformed credentials/limits before touching any live registration. */
export function validateProviderReloadConfig(config: CanonryConfig): void {
  if (!reloadConfigSchema.safeParse(config).success) {
    throw validationError('Provider configuration is invalid; repair config.yaml and retry.')
  }
}

/** The same complete provider registration set for startup and explicit reload. */
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
      registered.push(resolveRegistration(adapter, providerConfigFromEntry(adapter.name, entry, entry.quota ?? DEFAULT_PROVIDER_QUOTA)))
    }
  }
  if (isCdpProviderRegistrable(config.cdp)) {
    registered.push(resolveRegistration(cdpAdapter, {
      provider: cdpAdapter.name,
      cdpEndpoint: `ws://${config.cdp?.host ?? 'localhost'}:${config.cdp?.port ?? 9222}`,
      quotaPolicy: config.cdp?.quota ?? DEFAULT_CDP_QUOTA,
    }))
  }
  return registered
}
