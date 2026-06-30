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
 * The project tab to actually render under an embed `projectTabs` allowlist: the
 * requested tab when allowed, otherwise `overview` (or the first allowed tab when
 * even overview is hidden). With no allowlist the requested tab is unchanged. So a
 * direct-URL hit on a hidden tab falls back to a visible board, never an empty page.
 */
export function resolveEmbedProjectTab<T extends string>(requested: T, allow: readonly string[] | undefined): T {
  if (isEmbedProjectTabAllowed(requested, allow)) return requested
  if (!allow || allow.length === 0) return requested
  return (allow.includes('overview') ? 'overview' : allow[0]) as T
}

/**
 * Embed theme keys → namespaced CSS custom properties consumed by the embed
 * shell (`.app-shell-embed` in styles.css). Limited to the shell background +
 * text on purpose: the dashboard's content uses fixed Tailwind colors, so a
 * broader palette (surface / accent / border / …) would need component-level
 * wiring and is out of scope for the read-only embed. Unknown keys are dropped.
 */
const THEME_VARS: Record<string, string> = {
  bg: '--canonry-embed-bg',
  fg: '--canonry-embed-fg',
}

/**
 * Strict color form: hex (3/4/6/8), `rgb()/rgba()`, or `hsl()/hsla()`. The
 * anchored char classes exclude `;`, `{`, `}`, `:`, and `<`, so a value can
 * never break out of the inline `style` attribute it is written into.
 */
const COLOR_VALUE =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([0-9.,%\s/]+\)|hsla?\([0-9.,%\s/a-z]+\))$/i

/**
 * Map a host-supplied theme to safe CSS custom properties. Unknown keys and any
 * value that is not a strict color form are dropped (CSS-injection guard);
 * applied via the React `style` prop, never a `<style>` tag.
 */
export function embedThemeStyle(theme: Record<string, string> | undefined): CSSProperties {
  if (!theme) return {}
  const style: Record<string, string> = {}
  for (const [key, value] of Object.entries(theme)) {
    const cssVar = THEME_VARS[key]
    if (!cssVar || typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!COLOR_VALUE.test(trimmed)) continue
    style[cssVar] = trimmed
  }
  return style as CSSProperties
}
