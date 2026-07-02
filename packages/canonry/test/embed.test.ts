import { describe, it, expect } from 'vitest'
import { resolveEmbedConfig } from '../src/embed.js'
import type { CanonryConfig } from '../src/config.js'

function baseConfig(embed?: CanonryConfig['embed']): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/test.db',
    apiKey: 'cnry_test',
    ...(embed ? { embed } : {}),
  }
}

describe('resolveEmbedConfig', () => {
  it('is disabled by default with no env and no config', () => {
    expect(resolveEmbedConfig({}, baseConfig())).toEqual({ enabled: false, allowedOrigins: [] })
  })

  it('CANONRY_EMBED enables even without config', () => {
    expect(resolveEmbedConfig({ CANONRY_EMBED: '1' }, baseConfig()).enabled).toBe(true)
    expect(resolveEmbedConfig({ CANONRY_EMBED: 'true' }, baseConfig()).enabled).toBe(true)
    expect(resolveEmbedConfig({ CANONRY_EMBED: 'TRUE' }, baseConfig()).enabled).toBe(true)
  })

  it('CANONRY_EMBED=0/false overrides a config that enables embed', () => {
    const cfg = baseConfig({ enabled: true })
    expect(resolveEmbedConfig({ CANONRY_EMBED: '0' }, cfg).enabled).toBe(false)
    expect(resolveEmbedConfig({ CANONRY_EMBED: 'false' }, cfg).enabled).toBe(false)
  })

  it('honors config.embed.enabled when no env var is set', () => {
    expect(resolveEmbedConfig({}, baseConfig({ enabled: true })).enabled).toBe(true)
    expect(resolveEmbedConfig({}, baseConfig({ enabled: false })).enabled).toBe(false)
  })

  it('treats an empty CANONRY_EMBED as unset (falls back to config)', () => {
    expect(resolveEmbedConfig({ CANONRY_EMBED: '' }, baseConfig({ enabled: true })).enabled).toBe(true)
  })

  it('CANONRY_EMBED_ORIGINS overrides config.allowOrigins (env wins)', () => {
    const cfg = baseConfig({ enabled: true, allowOrigins: ['https://config.example'] })
    expect(
      resolveEmbedConfig({ CANONRY_EMBED: '1', CANONRY_EMBED_ORIGINS: 'https://env.example' }, cfg).allowedOrigins,
    ).toEqual(['https://env.example'])
  })

  it('uses config.allowOrigins (normalized) when the env var is unset', () => {
    const cfg = baseConfig({ enabled: true, allowOrigins: ['https://A.example/', 'bogus', 'https://b.example'] })
    expect(resolveEmbedConfig({ CANONRY_EMBED: '1' }, cfg).allowedOrigins).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('an explicitly-empty CANONRY_EMBED_ORIGINS clears config origins (fail closed)', () => {
    const cfg = baseConfig({ enabled: true, allowOrigins: ['https://config.example'] })
    expect(resolveEmbedConfig({ CANONRY_EMBED: '1', CANONRY_EMBED_ORIGINS: '' }, cfg).allowedOrigins).toEqual([])
  })

  it('parses CANONRY_EMBED_VIEWS on comma + whitespace and lowercases', () => {
    const out = resolveEmbedConfig({ CANONRY_EMBED: '1', CANONRY_EMBED_VIEWS: 'Overview, project  runs' }, baseConfig())
    expect(out.views).toEqual(['overview', 'project', 'runs'])
  })

  it('normalizes an empty / whitespace-only views list to undefined (= all views), never []', () => {
    expect(resolveEmbedConfig({ CANONRY_EMBED: '1', CANONRY_EMBED_VIEWS: '   ' }, baseConfig()).views).toBeUndefined()
    expect(resolveEmbedConfig({ CANONRY_EMBED: '1' }, baseConfig()).views).toBeUndefined()
  })

  it('carries config.embed.theme through verbatim', () => {
    const cfg = baseConfig({ enabled: true, theme: { accent: '#0af' } })
    expect(resolveEmbedConfig({}, cfg).theme).toEqual({ accent: '#0af' })
  })

  it('parses CANONRY_EMBED_PROJECT_TABS on comma + whitespace and lowercases', () => {
    const out = resolveEmbedConfig(
      { CANONRY_EMBED: '1', CANONRY_EMBED_PROJECT_TABS: 'Overview, technical-aeo  report' },
      baseConfig(),
    )
    expect(out.projectTabs).toEqual(['overview', 'technical-aeo', 'report'])
  })

  it('CANONRY_EMBED_PROJECT_TABS overrides config.embed.projectTabs (env wins)', () => {
    const cfg = baseConfig({ enabled: true, projectTabs: ['overview', 'backlinks'] })
    expect(
      resolveEmbedConfig({ CANONRY_EMBED: '1', CANONRY_EMBED_PROJECT_TABS: 'overview, technical-aeo' }, cfg).projectTabs,
    ).toEqual(['overview', 'technical-aeo'])
  })

  it('uses config.embed.projectTabs when the env var is unset', () => {
    const cfg = baseConfig({ enabled: true, projectTabs: ['overview', 'technical-aeo'] })
    expect(resolveEmbedConfig({ CANONRY_EMBED: '1' }, cfg).projectTabs).toEqual(['overview', 'technical-aeo'])
  })

  it('normalizes an empty / whitespace-only projectTabs list to undefined (= all tabs), never []', () => {
    expect(
      resolveEmbedConfig({ CANONRY_EMBED: '1', CANONRY_EMBED_PROJECT_TABS: '   ' }, baseConfig()).projectTabs,
    ).toBeUndefined()
    expect(resolveEmbedConfig({ CANONRY_EMBED: '1' }, baseConfig()).projectTabs).toBeUndefined()
  })
})
