/**
 * Resolve the server port from environment/config. CLI flags are applied to
 * CANONRY_PORT before `serveCommand` calls this helper.
 */
export function resolveServePort(envPort: string | undefined, configPort: number | undefined): number {
  const trimmed = envPort?.trim()
  if (trimmed) return parseInt(trimmed, 10)
  return configPort ?? 4100
}
