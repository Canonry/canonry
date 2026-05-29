import type { CanonryConfig } from './config.js'

export type PlacesTierConfig = 'atmosphere' | 'pro' | 'off'

export interface ResolvedPlacesConfig {
  /** Places API key, or undefined when not configured. */
  apiKey?: string
  /** Field-mask / cost tier. 'off' disables Places enrichment entirely. */
  tier: PlacesTierConfig
  /** Minimum age (days) before a location's Place Details is re-fetched. */
  refreshIntervalDays: number
}

const DEFAULT_TIER: PlacesTierConfig = 'atmosphere'
const DEFAULT_REFRESH_INTERVAL_DAYS = 7

function parseTier(raw: string | undefined): PlacesTierConfig | undefined {
  return raw === 'atmosphere' || raw === 'pro' || raw === 'off' ? raw : undefined
}

/**
 * Resolve the effective Places config: env vars override `config.yaml`, which
 * overrides defaults. Mirrors the env-over-config precedence used elsewhere.
 * The API key is a deployment secret (`GOOGLE_PLACES_API_KEY`); tier + refresh
 * interval can also be set via env for config-less cloud deployments.
 */
export function getPlacesConfig(config: CanonryConfig): ResolvedPlacesConfig {
  const envKey = process.env.GOOGLE_PLACES_API_KEY?.trim()
  const apiKey = envKey || config.places?.apiKey || undefined

  const tier = parseTier(process.env.GOOGLE_PLACES_TIER?.trim())
    ?? config.places?.tier
    ?? DEFAULT_TIER

  const envInterval = Number(process.env.GOOGLE_PLACES_REFRESH_INTERVAL_DAYS)
  const refreshIntervalDays = Number.isFinite(envInterval) && envInterval > 0
    ? envInterval
    : config.places?.refreshIntervalDays ?? DEFAULT_REFRESH_INTERVAL_DAYS

  return { apiKey, tier, refreshIntervalDays }
}
