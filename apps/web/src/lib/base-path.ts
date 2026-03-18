// Strip the base path prefix so routing works correctly under sub-paths (e.g. /canonry/).
// The server injects window.__CANONRY_CONFIG__.basePath at runtime via `canonry serve --base-path`.
function _getRuntimeBasePath(): string {
  if (typeof window !== 'undefined' && window.__CANONRY_CONFIG__?.basePath) {
    return window.__CANONRY_CONFIG__.basePath
  }
  return '/'
}
export const _BASE_URL: string = _getRuntimeBasePath()
export const _BASE_PREFIX: string = _BASE_URL === '/' ? '' : _BASE_URL.replace(/\/$/, '')

/**
 * Returns the full href for an app-internal path, including the base prefix.
 * Use this on <a href> so that right-click / middle-click also land correctly.
 * e.g. appHref('/setup') → '/canonry/setup' (sub-path) or '/setup' (root)
 */
export function appHref(path: string): string {
  return _BASE_PREFIX + path
}

export function normalizePathname(pathname: string): string {
  if (!pathname) {
    return '/'
  }

  const normalized = pathname.split('?')[0] ?? '/'
  if (normalized === '') {
    return '/'
  }

  // Strip sub-path prefix (e.g. /canonry) so router sees clean paths
  const stripped = _BASE_PREFIX && normalized.startsWith(_BASE_PREFIX)
    ? normalized.slice(_BASE_PREFIX.length) || '/'
    : normalized

  return stripped.length > 1 && stripped.endsWith('/') ? stripped.slice(0, -1) : stripped
}
