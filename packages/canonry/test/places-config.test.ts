import { describe, it, expect, afterEach } from 'vitest'
import { getPlacesConfig } from '../src/places-config.js'
import type { CanonryConfig } from '../src/config.js'

const BASE: CanonryConfig = { apiUrl: 'http://x', database: 'd', apiKey: 'k' }

function withConfig(places: CanonryConfig['places']): CanonryConfig {
  return { ...BASE, places }
}

describe('getPlacesConfig', () => {
  const ENV_KEYS = ['GOOGLE_PLACES_API_KEY', 'GOOGLE_PLACES_TIER', 'GOOGLE_PLACES_REFRESH_INTERVAL_DAYS']
  afterEach(() => { for (const k of ENV_KEYS) delete process.env[k] })

  it('defaults to atmosphere tier + 7-day refresh + no key when nothing is set', () => {
    const cfg = getPlacesConfig(BASE)
    expect(cfg.tier).toBe('atmosphere')
    expect(cfg.refreshIntervalDays).toBe(7)
    expect(cfg.apiKey).toBeUndefined()
  })

  it('reads apiKey / tier / refreshIntervalDays from config.yaml', () => {
    const cfg = getPlacesConfig(withConfig({ apiKey: 'cfg-key', tier: 'pro', refreshIntervalDays: 14 }))
    expect(cfg.apiKey).toBe('cfg-key')
    expect(cfg.tier).toBe('pro')
    expect(cfg.refreshIntervalDays).toBe(14)
  })

  it('lets GOOGLE_PLACES_API_KEY env override the config.yaml key', () => {
    process.env.GOOGLE_PLACES_API_KEY = 'env-key'
    expect(getPlacesConfig(withConfig({ apiKey: 'cfg-key' })).apiKey).toBe('env-key')
  })

  it('lets GOOGLE_PLACES_TIER + refresh-interval env override config', () => {
    process.env.GOOGLE_PLACES_TIER = 'off'
    process.env.GOOGLE_PLACES_REFRESH_INTERVAL_DAYS = '30'
    const cfg = getPlacesConfig(withConfig({ tier: 'atmosphere', refreshIntervalDays: 7 }))
    expect(cfg.tier).toBe('off')
    expect(cfg.refreshIntervalDays).toBe(30)
  })

  it('ignores an invalid tier env value and falls back to config/default', () => {
    process.env.GOOGLE_PLACES_TIER = 'platinum'
    expect(getPlacesConfig(withConfig({ tier: 'pro' })).tier).toBe('pro')
    expect(getPlacesConfig(BASE).tier).toBe('atmosphere')
  })

  it('ignores a non-positive refresh interval and falls back', () => {
    process.env.GOOGLE_PLACES_REFRESH_INTERVAL_DAYS = '0'
    expect(getPlacesConfig(withConfig({ refreshIntervalDays: 10 })).refreshIntervalDays).toBe(10)
  })

  it('treats a blank env key as unset (uses config)', () => {
    process.env.GOOGLE_PLACES_API_KEY = '   '
    expect(getPlacesConfig(withConfig({ apiKey: 'cfg-key' })).apiKey).toBe('cfg-key')
  })
})
