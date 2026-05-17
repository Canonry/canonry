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

