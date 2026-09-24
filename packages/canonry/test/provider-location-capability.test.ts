import { describe, expect, it } from 'vitest'
import { getProviderLocationHandling, providerSupportsLocationContext, type ProviderAdapter } from '@ainyc/canonry-contracts'
import { claudeAdapter } from '@ainyc/canonry-provider-claude'
import { openaiAdapter } from '@ainyc/canonry-provider-openai'
import { geminiAdapter } from '@ainyc/canonry-provider-gemini'
import { perplexityAdapter } from '@ainyc/canonry-provider-perplexity'
import { localAdapter } from '@ainyc/canonry-provider-local'
import { cdpChatgptAdapter } from '@ainyc/canonry-provider-cdp'

/**
 * The geo capability has to be verifiable, not asserted. Each expectation
 * below was read out of the adapter's own request builder:
 *
 *   openai      normalize.ts sets `user_location` on the web_search tool
 *   claude      normalize.ts sets `user_location` on the web_search tool
 *   gemini      normalize.ts appends the location to the prompt text
 *   perplexity  normalize.ts sets `user_location` on the web_search tool
 *   local       normalize.ts appends the location to the system message
 *   cdp:chatgpt sends nothing; the browser session's own geolocation decides
 */
const ADAPTERS: Array<{ adapter: ProviderAdapter; supports: boolean }> = [
  { adapter: openaiAdapter, supports: true },
  { adapter: claudeAdapter, supports: true },
  { adapter: geminiAdapter, supports: true },
  { adapter: perplexityAdapter, supports: true },
  { adapter: localAdapter, supports: true },
  { adapter: cdpChatgptAdapter, supports: false },
]

describe('provider location capability', () => {
  it.each(ADAPTERS)('$adapter.name declares whether the location reaches the request', ({ adapter, supports }) => {
    expect(adapter.supportsLocationContext).toBe(supports)
    expect(providerSupportsLocationContext(adapter)).toBe(supports)
  })

  it.each(ADAPTERS)('$adapter.name agrees with the published location-handling table', ({ adapter, supports }) => {
    expect(getProviderLocationHandling(adapter.name).supportsLocationContext).toBe(supports)
  })

  it('treats an adapter that declares nothing as location-blind', () => {
    expect(providerSupportsLocationContext({})).toBe(false)
    expect(getProviderLocationHandling('not-a-real-provider').supportsLocationContext).toBe(false)
  })
})
