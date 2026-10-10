import { describe, expect, it } from 'vitest'
import { isApiProviderRegistrable, isCdpProviderRegistrable, registeredProviderNames } from '../src/provider-registration.js'

describe('the provider registration rule', () => {
  it('registers Gemini from an API key or a Vertex project', () => {
    expect(isApiProviderRegistrable('gemini', { apiKey: 'k' })).toBe(true)
    expect(isApiProviderRegistrable('gemini', { vertexProject: 'my-gcp-project' })).toBe(true)
    expect(isApiProviderRegistrable('gemini', { model: 'gemini-2.5-flash' })).toBe(false)
  })

  it('registers local from a base URL and every other adapter from an API key only', () => {
    expect(isApiProviderRegistrable('local', { baseUrl: 'http://127.0.0.1:11434' })).toBe(true)
    expect(isApiProviderRegistrable('local', { apiKey: 'k' })).toBe(false)
    // A custom endpoint alone does not register an API provider.
    expect(isApiProviderRegistrable('openai', { baseUrl: 'https://proxy.example' })).toBe(false)
    expect(isApiProviderRegistrable('openai', { apiKey: 'k' })).toBe(true)
    expect(isApiProviderRegistrable('openai', undefined)).toBe(false)
  })

  it('registers the CDP browser provider from a host or a port', () => {
    expect(isCdpProviderRegistrable({ host: 'localhost' })).toBe(true)
    expect(isCdpProviderRegistrable({ port: 9222 })).toBe(true)
    expect(isCdpProviderRegistrable({})).toBe(false)
    expect(isCdpProviderRegistrable(undefined)).toBe(false)
  })

  it('names every provider the server would register, and nothing else', () => {
    expect(registeredProviderNames({
      providers: {
        gemini: { vertexProject: 'my-gcp-project' },
        openai: { baseUrl: 'https://proxy.example' },
        claude: { apiKey: 'k' },
        retired: { apiKey: 'k' },
      },
      cdp: { port: 9222 },
    })).toEqual(['gemini', 'claude', 'cdp:chatgpt'])
    expect(registeredProviderNames({})).toEqual([])
  })

  it('counts a legacy top-level Gemini key the way boot migrates it', () => {
    expect(registeredProviderNames({ geminiApiKey: 'legacy' })).toEqual(['gemini'])
    // Boot migrates it only when providers.gemini is absent.
    expect(registeredProviderNames({ geminiApiKey: 'legacy', providers: { gemini: { model: 'm' } } })).toEqual([])
  })
})
