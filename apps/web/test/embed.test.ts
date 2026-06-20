import { describe, it, expect, afterEach } from 'vitest'
import { embedViewIdForPath, embedThemeStyle } from '../src/embed.js'
import { getEmbedConfig } from '../src/api.js'

type WindowLike = { __CANONRY_CONFIG__?: { embed?: { enabled: boolean; views?: string[]; theme?: Record<string, string> } } }
const globalRef = globalThis as typeof globalThis & { window?: WindowLike }

describe('embedViewIdForPath', () => {
  it('maps known route prefixes to coarse view ids', () => {
    expect(embedViewIdForPath('/')).toBe('overview')
    expect(embedViewIdForPath('/projects')).toBe('projects')
    expect(embedViewIdForPath('/projects/project_citypoint')).toBe('project')
    expect(embedViewIdForPath('/projects/project_citypoint/search-console')).toBe('project')
    expect(embedViewIdForPath('/runs')).toBe('runs')
    expect(embedViewIdForPath('/traffic')).toBe('traffic')
    expect(embedViewIdForPath('/traffic/acme/src_1')).toBe('traffic')
    expect(embedViewIdForPath('/backlinks')).toBe('backlinks')
    expect(embedViewIdForPath('/settings')).toBe('settings')
    expect(embedViewIdForPath('/setup')).toBe('setup')
  })

  it('falls back to "other" for unknown paths and tolerates a trailing slash', () => {
    expect(embedViewIdForPath('/whatever')).toBe('other')
    expect(embedViewIdForPath('/runs/')).toBe('runs')
  })
})

describe('embedThemeStyle', () => {
  it('keeps the two shell theme keys with valid hex / rgb / hsl values', () => {
    expect(embedThemeStyle({ bg: '#0af', fg: 'rgb(10, 20, 30)' })).toEqual({
      '--canonry-embed-bg': '#0af',
      '--canonry-embed-fg': 'rgb(10, 20, 30)',
    })
    expect(embedThemeStyle({ bg: 'hsl(200, 50%, 50%)' })).toEqual({
      '--canonry-embed-bg': 'hsl(200, 50%, 50%)',
    })
  })

  it('drops unsupported keys, even with a valid color', () => {
    expect(embedThemeStyle({ evil: '#fff' })).toEqual({})
    // surface/muted/accent/border are not wired into the shell — they are dropped.
    expect(embedThemeStyle({ accent: '#fff', surface: '#000', border: '#111' })).toEqual({})
  })

  it('drops hostile values on supported keys (CSS-injection guard)', () => {
    expect(embedThemeStyle({ bg: 'red; } body { display: none }' })).toEqual({})
    expect(embedThemeStyle({ bg: 'url(https://evil.example)' })).toEqual({})
    expect(embedThemeStyle({ fg: 'expression(alert(1))' })).toEqual({})
  })

  it('returns {} for empty or undefined theme', () => {
    expect(embedThemeStyle(undefined)).toEqual({})
    expect(embedThemeStyle({})).toEqual({})
  })
})

describe('getEmbedConfig', () => {
  const original = globalRef.window

  afterEach(() => {
    if (original === undefined) delete globalRef.window
    else globalRef.window = original
  })

  it('returns null when window is undefined', () => {
    delete globalRef.window
    expect(getEmbedConfig()).toBeNull()
  })

  it('returns null when no embed block or embed is not enabled', () => {
    globalRef.window = { __CANONRY_CONFIG__: {} }
    expect(getEmbedConfig()).toBeNull()
    globalRef.window = { __CANONRY_CONFIG__: { embed: { enabled: false } } }
    expect(getEmbedConfig()).toBeNull()
  })

  it('returns the embed block when enabled', () => {
    globalRef.window = { __CANONRY_CONFIG__: { embed: { enabled: true, views: ['overview'] } } }
    expect(getEmbedConfig()).toEqual({ enabled: true, views: ['overview'] })
  })
})
