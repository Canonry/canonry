import { describe, it, expect, afterEach } from 'vitest'
import {
  EMBED_PROJECT_TABS,
  effectiveEmbedProjectTabs,
  embedViewIdForPath,
  embedThemeStyle,
  embedThemeMode,
  filterEmbedProjectTabs,
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

  it('ignores font overrides so embeds always use the bundled Geist family', () => {
    expect(embedThemeStyle({ font: 'Inter' })).toEqual({})
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

  it('falls back to overview when filtering leaves no valid tabs', () => {
    expect(resolveEmbedProjectTab('portfolio', filterEmbedProjectTabs(['portfolio', 'unknown']))).toBe('overview')
    expect(resolveEmbedProjectTab('portfolio', [])).toBe('overview')
  })
})

describe('filterEmbedProjectTabs', () => {
  it('removes operator-only and unknown tabs', () => {
    expect(filterEmbedProjectTabs(['overview', 'portfolio', 'unknown', 'report'])).toEqual(['overview', 'report'])
  })

  it('defaults an unset allowlist to every embed-safe project tab', () => {
    const tabs = filterEmbedProjectTabs(undefined)
    expect(tabs).toContain('overview')
    expect(tabs).toContain('search-console')
    expect(tabs).not.toContain('portfolio')
  })

  it('returns a safe fallback when every configured tab is rejected', () => {
    expect(filterEmbedProjectTabs(['portfolio', 'not-a-tab'])).toEqual(['overview'])
  })
})

describe('effectiveEmbedProjectTabs', () => {
  it('leaves every tab visible outside embed mode, including portfolio', () => {
    expect(effectiveEmbedProjectTabs(null)).toBeUndefined()
    expect(isEmbedProjectTabAllowed('portfolio', effectiveEmbedProjectTabs(null))).toBe(true)
  })

  // The raw host list is `undefined` here, and `isEmbedProjectTabAllowed` reads
  // `undefined` as "every tab". Normalizing first is what keeps portfolio out.
  it('uses the embed-safe set when an embed sends no tab allowlist', () => {
    expect(effectiveEmbedProjectTabs({})).toEqual([...EMBED_PROJECT_TABS])
    expect(isEmbedProjectTabAllowed('portfolio', effectiveEmbedProjectTabs({}))).toBe(false)
  })

  it('drops portfolio even when the host names it explicitly', () => {
    expect(effectiveEmbedProjectTabs({ projectTabs: ['overview', 'portfolio'] })).toEqual(['overview'])
    expect(isEmbedProjectTabAllowed('portfolio', effectiveEmbedProjectTabs({ projectTabs: ['portfolio'] }))).toBe(false)
  })
})

// The project tab's visible label is "AI Visibility", but its id stays
// `overview`. Embed installs list that id in CANONRY_EMBED_PROJECT_TABS and it
// appears in saved URLs, so renaming it would silently empty an existing
// allowlist and fall every embed back to a different tab.
it('keeps the overview tab id on the wire however the label reads', () => {
  expect(isEmbedProjectTabAllowed('overview', ['overview'])).toBe(true)
  expect(resolveEmbedProjectTab('overview', ['overview', 'technical-aeo'])).toBe('overview')
  expect(isEmbedProjectTabAllowed('ai-visibility', ['overview'])).toBe(false)
})

// Site Health replaces the visible Technical AEO label, but existing embed
// allowlists and saved routes must continue to use the stable wire token.
it('keeps the technical-aeo tab id on the wire however the Site Health label reads', () => {
  expect(isEmbedProjectTabAllowed('technical-aeo', ['technical-aeo'])).toBe(true)
  expect(resolveEmbedProjectTab('technical-aeo', ['overview', 'technical-aeo'])).toBe('technical-aeo')
  expect(isEmbedProjectTabAllowed('site-health', ['technical-aeo'])).toBe(false)
})
