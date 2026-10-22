/**
 * Resolve the server port from environment/config. CLI flags are applied to
 * CANONRY_PORT before `serveCommand` calls this helper.
 */
export function resolveServePort(envPort: string | undefined, configPort: number | undefined): number {
  const trimmed = envPort?.trim()
  if (trimmed) return parseInt(trimmed, 10)
  return configPort ?? 4100
}

/**
 * Whether `host` is a loopback bind — only the local machine can reach a
 * server bound here. `undefined` (programmatic/test callers that never bind a
 * socket) is treated as loopback. `0.0.0.0` / `::` (bind-all) and any specific
 * LAN/public address are NOT loopback.
 */
export function isLoopbackBindHost(host: string | undefined): boolean {
  if (host == null || host === '') return true
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  // IPv4 loopback is the whole 127.0.0.0/8 block.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true
  return false
}
