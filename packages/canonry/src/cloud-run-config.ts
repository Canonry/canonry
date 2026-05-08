import type { CanonryConfig, CloudRunConnectionConfigEntry } from './config.js'

function ensureConnections(config: CanonryConfig): CloudRunConnectionConfigEntry[] {
  if (!config.cloudRun) config.cloudRun = {}
  if (!config.cloudRun.connections) config.cloudRun.connections = []
  return config.cloudRun.connections
}

export function listCloudRunConnections(config: CanonryConfig): CloudRunConnectionConfigEntry[] {
  return config.cloudRun?.connections ?? []
}

export function getCloudRunConnection(
  config: CanonryConfig,
  projectName: string,
): CloudRunConnectionConfigEntry | undefined {
  return (config.cloudRun?.connections ?? []).find((c) => c.projectName === projectName)
}

export function upsertCloudRunConnection(
  config: CanonryConfig,
  connection: CloudRunConnectionConfigEntry,
): CloudRunConnectionConfigEntry {
  const connections = ensureConnections(config)
  const index = connections.findIndex((c) => c.projectName === connection.projectName)

  if (index === -1) {
    connections.push(connection)
    return connection
  }

  connections[index] = connection
  return connection
}

export function removeCloudRunConnection(
  config: CanonryConfig,
  projectName: string,
): boolean {
  const connections = config.cloudRun?.connections
  if (!connections?.length) return false

  const next = connections.filter((c) => c.projectName !== projectName)
  if (next.length === connections.length) return false

  if (!config.cloudRun) return false
  config.cloudRun.connections = next
  if (next.length === 0) {
    delete config.cloudRun
  }
  return true
}
