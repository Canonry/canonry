import {
  providerBatchConfigSchema,
  providerPricingSchema,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderQuotaPolicy,
} from '@ainyc/canonry-contracts'
import { CliError } from './cli-error.js'
import type { ProviderConfigEntry } from './config.js'
import type { ProviderRegistry } from './provider-registry.js'

/**
 * Instance-level batch dispatch settings (#1201): `providers.<name>.batch` and
 * `providers.<name>.pricing` in config.yaml, and the one rule for which
 * registered providers can be batched right now.
 */

function issuesText(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map(issue => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; ')
}

/**
 * Validate every provider's `batch` and `pricing` block against the contracts
 * schemas and replace each with its parsed value (so `batch.enabled` is always
 * a boolean). A malformed block refuses the config rather than silently
 * running sync or pricing with a typo.
 */
export function normalizeProviderBatchSettings(
  // A provider key left empty in YAML parses as null.
  providers: Record<string, ProviderConfigEntry | null | undefined> | undefined,
  configPath: string,
): void {
  for (const [name, entry] of Object.entries(providers ?? {})) {
    if (!entry) continue
    if (entry.batch !== undefined) {
      const parsed = providerBatchConfigSchema.safeParse(entry.batch)
      if (!parsed.success) {
        throw new CliError({
          code: 'CONFIG_INVALID',
          message: `Invalid config at ${configPath}: providers.${name}.batch is invalid (${issuesText(parsed.error.issues)}). `
            + 'Allowed keys: enabled (true/false), maxRequestsPerBatch (positive integer), deadlineHours (positive number).',
        })
      }
      entry.batch = parsed.data
    }
    if (entry.pricing !== undefined) {
      const parsed = providerPricingSchema.safeParse(entry.pricing)
      if (!parsed.success) {
        throw new CliError({
          code: 'CONFIG_INVALID',
          message: `Invalid config at ${configPath}: providers.${name}.pricing is invalid (${issuesText(parsed.error.issues)}). `
            + 'Prices are USD: inputPerMTok / cachedInputPerMTok / cacheWritePerMTok / outputPerMTok per million tokens, searchPer1k per 1,000 searches.',
        })
      }
      entry.pricing = parsed.data
    }
  }
}

/** The `ProviderConfig` a registered provider runs with, from its config.yaml entry. */
export function providerConfigFromEntry(name: string, entry: ProviderConfigEntry, quotaPolicy: ProviderQuotaPolicy): ProviderConfig {
  return {
    provider: name,
    apiKey: entry.apiKey,
    baseUrl: entry.baseUrl,
    model: entry.model,
    quotaPolicy,
    vertexProject: entry.vertexProject,
    vertexRegion: entry.vertexRegion,
    vertexCredentials: entry.vertexCredentials,
    ...(entry.batch ? { batch: entry.batch } : {}),
    ...(entry.pricing ? { pricing: entry.pricing } : {}),
  }
}

/**
 * Whether an adapter can dispatch through a batch API at all: the capability
 * plus the build/parse split that makes a batch line identical to a sync call.
 */
export function adapterSupportsBatch(adapter: ProviderAdapter): boolean {
  return adapter.batch !== undefined
    && adapter.buildTrackedQueryRequest !== undefined
    && adapter.parseTrackedQueryResponse !== undefined
}

/**
 * Registered providers this host can batch now: the adapter supports it AND
 * config.yaml sets `providers.<name>.batch.enabled: true`. Batch is off by
 * default and must stay off on zero-data-retention deployments.
 */
export function batchEligibleProviderNames(registry: ProviderRegistry): string[] {
  return registry.getAll()
    .filter(provider => provider.config.batch?.enabled === true && adapterSupportsBatch(provider.adapter))
    .map(provider => provider.adapter.name)
    .sort()
}

/**
 * Providers whose config enables batch but whose adapter cannot do it, for the
 * boot warning. A name with no adapter at all is not a provider canonry runs,
 * so it is left to the other config checks.
 */
export function providersWithUnsupportedBatch(
  // A provider key left empty in YAML parses as null.
  providers: Record<string, ProviderConfigEntry | null | undefined> | undefined,
  adapterFor: (name: string) => ProviderAdapter | undefined,
): string[] {
  return Object.entries(providers ?? {})
    .filter(([name, entry]) => {
      if (entry?.batch?.enabled !== true) return false
      const adapter = adapterFor(name)
      return adapter !== undefined && !adapterSupportsBatch(adapter)
    })
    .map(([name]) => name)
    .sort()
}
