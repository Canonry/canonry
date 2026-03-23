import type { CanonryConfig, Ga4ConnectionConfigEntry } from './config.js'

function ensureConnections(config: CanonryConfig): Ga4ConnectionConfigEntry[] {
  if (!config.ga4) config.ga4 = {}
  if (!config.ga4.connections) config.ga4.connections = []
  return config.ga4.connections
}

export function getGa4Connection(
  config: CanonryConfig,
  projectName: string,
): Ga4ConnectionConfigEntry | undefined {
  return (config.ga4?.connections ?? []).find((c) => c.projectName === projectName)
}

export function upsertGa4Connection(
  config: CanonryConfig,
  connection: Ga4ConnectionConfigEntry,
): Ga4ConnectionConfigEntry {
  const connections = ensureConnections(config)
  const index = connections.findIndex((c) => c.projectName === connection.projectName)

  if (index === -1) {
    connections.push(connection)
    return connection
  }

  connections[index] = connection
  return connection
}

export function removeGa4Connection(
  config: CanonryConfig,
  projectName: string,
): boolean {
  const connections = config.ga4?.connections
  if (!connections?.length) return false

  const next = connections.filter((c) => c.projectName !== projectName)
  if (next.length === connections.length) return false

  if (!config.ga4) return false
  config.ga4.connections = next
  if (next.length === 0) {
    delete config.ga4
  }
  return true
}
