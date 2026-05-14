import type { CanonryConfig, VercelTrafficConnectionConfigEntry } from './config.js'

function ensureConnections(config: CanonryConfig): VercelTrafficConnectionConfigEntry[] {
  if (!config.vercelTraffic) config.vercelTraffic = {}
  if (!config.vercelTraffic.connections) config.vercelTraffic.connections = []
  return config.vercelTraffic.connections
}

export function listVercelTrafficConnections(
  config: CanonryConfig,
): VercelTrafficConnectionConfigEntry[] {
  return config.vercelTraffic?.connections ?? []
}

export function getVercelTrafficConnection(
  config: CanonryConfig,
  projectName: string,
): VercelTrafficConnectionConfigEntry | undefined {
  return (config.vercelTraffic?.connections ?? []).find((c) => c.projectName === projectName)
}

export function upsertVercelTrafficConnection(
  config: CanonryConfig,
  connection: VercelTrafficConnectionConfigEntry,
): VercelTrafficConnectionConfigEntry {
  const connections = ensureConnections(config)
  const index = connections.findIndex((c) => c.projectName === connection.projectName)

  if (index === -1) {
    connections.push(connection)
    return connection
  }

  connections[index] = connection
  return connection
}

export function removeVercelTrafficConnection(
  config: CanonryConfig,
  projectName: string,
): boolean {
  const connections = config.vercelTraffic?.connections
  if (!connections?.length) return false

  const next = connections.filter((c) => c.projectName !== projectName)
  if (next.length === connections.length) return false

  if (!config.vercelTraffic) return false
  config.vercelTraffic.connections = next
  if (next.length === 0) {
    delete config.vercelTraffic
  }
  return true
}
