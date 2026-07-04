import { describe, it, expect, afterEach } from 'vitest'
import {
  embedViewIdForPath,
  embedThemeStyle,
  embedThemeMode,
  embedThemeFontHref,
  isEmbedProjectTabAllowed,
  resolveEmbedProjectTab,
} from '../src/embed.js'
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
    // surface/muted/border are not wired into the shell — they are dropped.
    expect(embedThemeStyle({ surface: '#000', border: '#111' })).toEqual({})
  })

  it('drops Object.prototype keys (own-property guard, not a proto-chain walk)', () => {
    expect(embedThemeStyle({ constructor: '#fff' })).toEqual({})
    expect(embedThemeStyle({ toString: '#fff', valueOf: '#000', hasOwnProperty: '#111' })).toEqual({})
  })

  it('maps accent to the inline-link color', () => {
    expect(embedThemeStyle({ accent: '#2563eb' })).toEqual({ '--color-link': '#2563eb' })
  })

  it('maps a valid font to --font-sans with the fallback stack', () => {
    expect(embedThemeStyle({ font: 'Inter' })).toEqual({
      '--font-sans': '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    })
  })

  it('drops a hostile font-family (its own guard, never the color regex)', () => {
    expect(embedThemeStyle({ font: 'Inter"; } body{display:none' })).toEqual({})
    expect(embedThemeStyle({ font: 'url(x)' })).toEqual({})
    expect(embedThemeStyle({ font: 'a:b' })).toEqual({})
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

describe('embedThemeMode', () => {
  it('returns the validated mode or undefined', () => {
    expect(embedThemeMode({ mode: 'light' })).toBe('light')
    expect(embedThemeMode({ mode: 'dark' })).toBe('dark')
    expect(embedThemeMode({ mode: 'sepia' })).toBeUndefined()
    expect(embedThemeMode({})).toBeUndefined()
    expect(embedThemeMode(undefined)).toBeUndefined()
  })
})

describe('embedThemeFontHref', () => {
  it('builds a Google Fonts URL for a valid family (spaces → +)', () => {
    expect(embedThemeFontHref({ font: 'Inter' })).toBe(
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
    )
    expect(embedThemeFontHref({ font: 'IBM Plex Sans' })).toBe(
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap',
    )
  })

  it('returns undefined for a missing or hostile family', () => {
    expect(embedThemeFontHref(undefined)).toBeUndefined()
    expect(embedThemeFontHref({})).toBeUndefined()
    expect(embedThemeFontHref({ font: 'url(x)' })).toBeUndefined()
    expect(embedThemeFontHref({ font: 'a;b' })).toBeUndefined()
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

describe('isEmbedProjectTabAllowed', () => {
  it('allows every tab when the allowlist is undefined (non-embed / unset)', () => {
    expect(isEmbedProjectTabAllowed('backlinks', undefined)).toBe(true)
    expect(isEmbedProjectTabAllowed('settings', undefined)).toBe(true)
  })

  it('allows only the listed tabs when an allowlist is set', () => {
    const allow = ['overview', 'technical-aeo']
    expect(isEmbedProjectTabAllowed('overview', allow)).toBe(true)
    expect(isEmbedProjectTabAllowed('technical-aeo', allow)).toBe(true)
    expect(isEmbedProjectTabAllowed('search-console', allow)).toBe(false)
    expect(isEmbedProjectTabAllowed('activity', allow)).toBe(false)
    expect(isEmbedProjectTabAllowed('backlinks', allow)).toBe(false)
  })
})

describe('resolveEmbedProjectTab', () => {
  it('returns the requested tab unchanged with no allowlist', () => {
    expect(resolveEmbedProjectTab('backlinks', undefined)).toBe('backlinks')
  })

  it('returns the requested tab when it is allowed', () => {
    expect(resolveEmbedProjectTab('technical-aeo', ['overview', 'technical-aeo'])).toBe('technical-aeo')
  })

  it('falls back to overview when the requested tab is hidden', () => {
    expect(resolveEmbedProjectTab('backlinks', ['overview', 'technical-aeo'])).toBe('overview')
    expect(resolveEmbedProjectTab('search-console', ['overview', 'technical-aeo'])).toBe('overview')
  })

  it('falls back to the first allowed tab when even overview is hidden', () => {
    expect(resolveEmbedProjectTab('backlinks', ['technical-aeo', 'report'])).toBe('technical-aeo')
  })
})
