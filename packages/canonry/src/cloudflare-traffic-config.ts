import type { CanonryConfig, CloudflareTrafficConnectionConfigEntry } from './config.js'

function ensureConnections(config: CanonryConfig): CloudflareTrafficConnectionConfigEntry[] {
  if (!config.cloudflareTraffic) config.cloudflareTraffic = {}
  if (!config.cloudflareTraffic.connections) config.cloudflareTraffic.connections = []
  return config.cloudflareTraffic.connections
}

export function listCloudflareTrafficConnections(
  config: CanonryConfig,
): CloudflareTrafficConnectionConfigEntry[] {
  return config.cloudflareTraffic?.connections ?? []
}

export function getCloudflareTrafficConnection(
  config: CanonryConfig,
  projectName: string,
): CloudflareTrafficConnectionConfigEntry | undefined {
  return (config.cloudflareTraffic?.connections ?? []).find((c) => c.projectName === projectName)
}

/**
 * Lookup by `sourceId` is the ingest path: the Worker forwards
 * `X-Canonry-Source-Id`, and the receiver resolves the matching credential
 * to verify the bearer and HMAC. Keyed separately from project name so a
 * forthcoming "many sources per project" model (e.g. multi-zone) doesn't
 * require a schema change.
 */
export function getCloudflareTrafficConnectionBySourceId(
  config: CanonryConfig,
  sourceId: string,
): CloudflareTrafficConnectionConfigEntry | undefined {
  return (config.cloudflareTraffic?.connections ?? []).find((c) => c.sourceId === sourceId)
}

export function upsertCloudflareTrafficConnection(
  config: CanonryConfig,
  connection: CloudflareTrafficConnectionConfigEntry,
): CloudflareTrafficConnectionConfigEntry {
  const connections = ensureConnections(config)
  const index = connections.findIndex((c) => c.projectName === connection.projectName)

  if (index === -1) {
    connections.push(connection)
    return connection
  }

  connections[index] = connection
  return connection
}

export function removeCloudflareTrafficConnection(
  config: CanonryConfig,
  projectName: string,
): boolean {
  const connections = config.cloudflareTraffic?.connections
  if (!connections?.length) return false

  const next = connections.filter((c) => c.projectName !== projectName)
  if (next.length === connections.length) return false

  if (!config.cloudflareTraffic) return false
  config.cloudflareTraffic.connections = next
  if (next.length === 0) {
    delete config.cloudflareTraffic
  }
  return true
}
