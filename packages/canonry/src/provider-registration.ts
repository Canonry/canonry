import { API_PROVIDER_NAMES, ProviderNames } from '@ainyc/canonry-contracts'
import type { CanonryConfig, CdpConfigEntry, ProviderConfigEntry } from './config.js'

/**
 * Whether the server registers this API provider at boot: `local` needs a
 * base URL, Gemini an API key or a Vertex project, every other adapter an API
 * key. One rule for boot registration, setup state, and `serve.started`, so
 * the CLI never calls an install provider-less while its server runs sweeps.
 */
export function isApiProviderRegistrable(name: string, entry: ProviderConfigEntry | undefined): boolean {
  if (!entry) return false
  if (name === ProviderNames.local) return Boolean(entry.baseUrl)
  if (name === ProviderNames.gemini) return Boolean(entry.apiKey || entry.vertexProject)
  return Boolean(entry.apiKey)
}

/** The CDP browser provider (`cdp:chatgpt`) registers when a host or a port is set. */
export function isCdpProviderRegistrable(cdp: CdpConfigEntry | undefined): boolean {
  return Boolean(cdp?.host || cdp?.port)
}

/**
 * Every answer provider the server registers from this config. Takes the raw
 * file too: a pre-providers-map config keeps its Gemini key at the top level,
 * and boot (like `loadConfig`) moves it into `providers.gemini` when that is absent.
 */
export function registeredProviderNames(config: Pick<CanonryConfig, 'providers' | 'cdp' | 'geminiApiKey'>): string[] {
  const names: string[] = API_PROVIDER_NAMES.filter(name => {
    const entry = config.providers?.[name]
    if (name === ProviderNames.gemini && !entry && config.geminiApiKey) return true
    return isApiProviderRegistrable(name, entry)
  })
  if (isCdpProviderRegistrable(config.cdp)) names.push(ProviderNames.cdpChatgpt)
  return names
}
