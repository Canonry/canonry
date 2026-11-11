import { describe, it, expect, afterEach } from 'vitest'
import {
  EMBED_PROJECT_TABS,
  effectiveEmbedProjectTabs,
  embedQueryLimit,
  embedTabToRemember,
  embedTabToRestore,
  embedViewIdForPath,
  embedThemeStyle,
  embedThemeMode,
  filterEmbedProjectTabs,
  isEmbedProjectTabAllowed,
  resolveEmbedProjectTab,
  resolveProjectPageTab,
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
    const allow = ['overview', 'agent-readiness']
    expect(isEmbedProjectTabAllowed('overview', allow)).toBe(true)
    expect(isEmbedProjectTabAllowed('agent-readiness', allow)).toBe(true)
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
    expect(resolveEmbedProjectTab('agent-readiness', ['overview', 'agent-readiness'])).toBe('agent-readiness')
  })

  it('falls back to overview when the requested tab is hidden', () => {
    expect(resolveEmbedProjectTab('backlinks', ['overview', 'agent-readiness'])).toBe('overview')
    expect(resolveEmbedProjectTab('search-console', ['overview', 'agent-readiness'])).toBe('overview')
  })

  it('falls back to the first allowed tab when even overview is hidden', () => {
    expect(resolveEmbedProjectTab('backlinks', ['agent-readiness', 'activity'])).toBe('agent-readiness')
  })

  it('falls back to overview when filtering leaves no valid tabs', () => {
    expect(resolveEmbedProjectTab('portfolio', filterEmbedProjectTabs(['portfolio', 'unknown']))).toBe('overview')
    expect(resolveEmbedProjectTab('portfolio', [])).toBe('overview')
  })
})

describe('filterEmbedProjectTabs', () => {
  it('removes operator-only and unknown tabs', () => {
    expect(filterEmbedProjectTabs(['overview', 'portfolio', 'unknown'])).toEqual(['overview'])
  })

  it('keeps retired Report grants closed, including mixed lists', () => {
    expect(filterEmbedProjectTabs(['report'])).toEqual([])
    expect(filterEmbedProjectTabs(['overview', 'report'])).toEqual([])
    expect(filterEmbedProjectTabs(['agent-readiness', 'REPORT'])).toEqual([])
    expect(filterEmbedProjectTabs(['technical-aeo', 'REPORT'])).toEqual([])
  })

  // Agent Readiness's tab key was `technical-aeo`. A host allowlist saved
  // before the rename keeps the tab under its current key, in the host's order,
  // and naming both keys grants it once.
  it('maps the retired technical-aeo key onto the Agent Readiness tab', () => {
    expect(filterEmbedProjectTabs(['overview', 'technical-aeo'])).toEqual(['overview', 'agent-readiness'])
    expect(filterEmbedProjectTabs(['technical-aeo', 'overview'])).toEqual(['agent-readiness', 'overview'])
    expect(filterEmbedProjectTabs(['technical-aeo', 'agent-readiness'])).toEqual(['agent-readiness'])
    expect(filterEmbedProjectTabs([' Technical-AEO '])).toEqual(['agent-readiness'])
    expect(filterEmbedProjectTabs(['technical-aeo', 'portfolio'])).toEqual(['agent-readiness'])
    expect(filterEmbedProjectTabs(undefined)).toContain('agent-readiness')
    expect(filterEmbedProjectTabs(undefined)).not.toContain('technical-aeo')
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
  expect(resolveEmbedProjectTab('overview', ['overview', 'agent-readiness'])).toBe('overview')
  expect(isEmbedProjectTabAllowed('ai-visibility', ['overview'])).toBe(false)
})

// The Agent Readiness tab is `agent-readiness` on the wire. An embed whose host
// still sends the retired `technical-aeo` key is normalized before any tab is
// checked, so the page it opens (and the subnav) is the Agent Readiness tab.
it('grants the Agent Readiness tab to a host that still lists technical-aeo', () => {
  const allow = effectiveEmbedProjectTabs({ projectTabs: ['overview', 'technical-aeo'] })
  expect(allow).toEqual(['overview', 'agent-readiness'])
  expect(isEmbedProjectTabAllowed('agent-readiness', allow)).toBe(true)
  expect(isEmbedProjectTabAllowed('technical-aeo', allow)).toBe(false)
  expect(resolveProjectPageTab('agent-readiness', { projectTabs: ['technical-aeo'] })).toBe('agent-readiness')
  expect(isEmbedProjectTabAllowed('site-health', allow)).toBe(false)
})

describe('embedQueryLimit', () => {
  it('reads a positive whole limit from the grant and nothing else', () => {
    expect(embedQueryLimit({ queries: { limit: 10 } })).toBe(10)
    for (const embed of [null, undefined, {}, { queries: {} }, { queries: { limit: 0 } }, { queries: { limit: 2.5 } }, { queries: { limit: '10' } }]) {
      expect(embedQueryLimit(embed as never)).toBeUndefined()
    }
  })
})

describe('resolveProjectPageTab', () => {
  it('opens the client Queries tab only under the grant', () => {
    expect(resolveProjectPageTab('client-queries', { queries: { limit: 10 } })).toBe('client-queries')
    // An embed without the grant falls back like any hidden tab, even if it lists the key.
    expect(resolveProjectPageTab('client-queries', { projectTabs: ['overview', 'client-queries'] })).toBe('overview')
    expect(resolveProjectPageTab('client-queries', { projectTabs: ['agent-readiness'] })).toBe('agent-readiness')
    expect(resolveProjectPageTab('client-queries', { projectTabs: ['technical-aeo'] })).toBe('agent-readiness')
    // Operators have no client Queries tab; theirs is the operator Queries tab.
    expect(resolveProjectPageTab('client-queries', null)).toBe('queries')
  })

  it('leaves every other tab to the embed allowlist', () => {
    expect(resolveProjectPageTab('agent-readiness', { projectTabs: ['overview'] })).toBe('overview')
    expect(resolveProjectPageTab('agent-readiness', null)).toBe('agent-readiness')
  })
})

describe('embed tab memory', () => {
  it('remembers project tabs and forgets on the first tab', () => {
    expect(embedTabToRemember('/projects/summit/client-queries')).toBe('/projects/summit/client-queries')
    expect(embedTabToRemember('/projects/summit/agent-readiness/')).toBe('/projects/summit/agent-readiness')
    expect(embedTabToRemember('/projects/summit')).toBeNull()
    expect(embedTabToRemember('/projects/summit/properties/north')).toBeNull()
    expect(embedTabToRemember('/settings')).toBeNull()
  })

  it('reopens a remembered tab only when a reload lands on the same project', () => {
    expect(embedTabToRestore('/projects/summit', '/projects/summit/client-queries')).toBe('/projects/summit/client-queries')
    expect(embedTabToRestore('/projects/summit/', '/projects/summit/client-queries')).toBe('/projects/summit/client-queries')
    expect(embedTabToRestore('/projects/other', '/projects/summit/client-queries')).toBeNull()
    expect(embedTabToRestore('/projects/summit/agent-readiness', '/projects/summit/client-queries')).toBeNull()
    expect(embedTabToRestore('/projects/summit', null)).toBeNull()
    expect(embedTabToRestore('/projects/summit', '/projects/summit/../settings')).toBeNull()
  })
})
