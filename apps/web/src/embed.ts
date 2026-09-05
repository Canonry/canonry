import type { CSSProperties } from 'react'

/**
 * Read-only embed mode (issue #716) — presentational helpers for the chromeless
 * SPA render. Pure value→value (no DOM, no window access) so they render safely
 * in `renderToStaticMarkup` and are unit-testable.
 */

/**
 * Collapse a pathname to a coarse view id used by the embed view allowlist.
 * Deliberately coarse: every `/projects/*` sub-tab shares the `project` id, so a
 * host opts a project's whole dashboard in or out as a unit (finer granularity
 * is an additive future change). NOT a security boundary — API data access is
 * governed solely by the API key scope (the single-tenant model).
 */
export function embedViewIdForPath(pathname: string): string {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (p === '/') return 'overview'
  if (p === '/projects') return 'projects'
  if (p.startsWith('/projects/')) return 'project'
  if (p === '/runs') return 'runs'
  if (p === '/traffic' || p.startsWith('/traffic/')) return 'traffic'
  if (p === '/backlinks') return 'backlinks'
  if (p === '/settings') return 'settings'
  if (p === '/setup') return 'setup'
  return 'other'
}

/**
 * Whether a project-page tab key is visible under an embed `projectTabs`
 * allowlist. An absent allowlist (non-embed, or embed without the option) means
 * every tab is visible. Finer-grained than `embedViewIdForPath`, which collapses
 * the whole project page to one `project` id and so cannot hide a single tab.
 * Presentational only, NOT a security boundary (the project-scoped API key
 * governs data access).
 */
export function isEmbedProjectTabAllowed(tab: string, allow: readonly string[] | undefined): boolean {
  return !allow || allow.includes(tab)
}

/**
 * Project tabs that are safe to expose in the read-only embed. Portfolio,
 * Queries (including its legacy Discovery alias), and Conversion Integrity
 * are operator-only setup and evidence surfaces, so they are deliberately
 * absent even when the host does not provide an explicit allowlist.
 */
export const EMBED_PROJECT_TABS = [
  'overview',
  'search-console',
  'local',
  'report',
  'activity',
  'backlinks',
  'technical-aeo',
  'history',
  'settings',
] as const

const EMBED_PROJECT_TAB_SET = new Set<string>(EMBED_PROJECT_TABS)

/**
 * Normalize host-provided project tabs before either navigation or rendering.
 * Unknown values and operator-only surfaces are dropped. A fully-invalid list
 * falls back to Overview so an embed can never resolve to a blank project page.
 */
export function filterEmbedProjectTabs(allow: readonly string[] | undefined): Array<(typeof EMBED_PROJECT_TABS)[number]> {
  const source = allow ?? EMBED_PROJECT_TABS
  const filtered = [...new Set(source.filter((tab): tab is (typeof EMBED_PROJECT_TABS)[number] =>
    EMBED_PROJECT_TAB_SET.has(tab),
  ))]
  return filtered.length > 0 ? filtered : ['overview']
}

/**
 * The project tab to actually render under an embed `projectTabs` allowlist: the
 * requested tab when allowed, otherwise `overview` (or the first allowed tab when
 * even overview is hidden). With no allowlist the requested tab is unchanged. So a
 * direct-URL hit on a hidden tab falls back to a visible board, never an empty page.
 */
export function resolveEmbedProjectTab<T extends string>(requested: T, allow: readonly string[] | undefined): T {
  if (isEmbedProjectTabAllowed(requested, allow)) return requested
  if (!allow) return requested
  return (allow.includes('overview') ? 'overview' : allow[0] ?? 'overview') as T
}

/**
 * Color-form embed theme keys → CSS custom property. `bg`/`fg` tint the embed
 * shell (`.app-shell-embed`); `accent` maps to the inline-link color — a narrow,
 * safe brand touch that leaves the semantic tone colors (positive/caution/
 * negative) intact. The broad palette re-skin is done by `mode` (light|dark) via
 * the `data-theme` attribute + the `[data-theme='light']` block in styles.css,
 * not here. Unknown keys are dropped.
 */
const THEME_COLOR_VARS: Record<string, string> = {
  bg: '--canonry-embed-bg',
  fg: '--canonry-embed-fg',
  accent: '--color-link',
}

/**
 * Strict color form: hex (3/4/6/8), `rgb()/rgba()`, or `hsl()/hsla()`. The
 * anchored char classes exclude `;`, `{`, `}`, `:`, and `<`, so a value can
 * never break out of the inline `style` attribute it is written into.
 */
const COLOR_VALUE =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([0-9.,%\s/]+\)|hsla?\([0-9.,%\s/a-z]+\))$/i

/**
 * The theme `mode` as a validated enum, or undefined. Drives the `data-theme`
 * attribute on the embed shell (only `light` has an override block; `dark` is
 * the default and a no-op). Presentational only.
 */
export function embedThemeMode(theme: Record<string, string> | undefined): 'light' | 'dark' | undefined {
  const mode = theme?.mode?.trim()
  return mode === 'light' || mode === 'dark' ? mode : undefined
}

/**
 * Map a host-supplied theme to safe CSS custom properties. Unknown keys and any
 * color value that is not a strict color form are dropped (CSS-injection guard).
 * Font overrides are intentionally unsupported: every dashboard uses the Geist
 * files shipped with Canonry, with no third-party or host-font dependency.
 * Applied via the React `style` prop, never a `<style>` tag.
 */
export function embedThemeStyle(theme: Record<string, string> | undefined): CSSProperties {
  if (!theme) return {}
  const style: Record<string, string> = {}
  for (const [key, value] of Object.entries(theme)) {
    // Own-property check: a bare `THEME_COLOR_VARS[key]` walks the prototype
    // chain, so keys like `constructor` / `toString` would return a truthy
    // inherited value and slip past the "unknown keys are dropped" guard.
    const cssVar = Object.hasOwn(THEME_COLOR_VARS, key) ? THEME_COLOR_VARS[key] : undefined
    if (!cssVar || typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!COLOR_VALUE.test(trimmed)) continue
    style[cssVar] = trimmed
  }
  return style as CSSProperties
}
