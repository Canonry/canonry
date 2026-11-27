import type { CanonryConfig, CloudRunConnectionConfigEntry } from './config.js'

type PersistCloudRun = (patch: Pick<CanonryConfig, 'cloudRun'>) => void

function saveConnections(config: CanonryConfig, connections: CloudRunConnectionConfigEntry[], persist?: PersistCloudRun) {
  const cloudRun = connections.length ? { ...config.cloudRun, connections } : undefined
  // A failed disk write must leave the previously saved credentials live.
  persist?.({ cloudRun })
  if (cloudRun) config.cloudRun = cloudRun
  else delete config.cloudRun
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
  persist?: PersistCloudRun,
): CloudRunConnectionConfigEntry {
  const connections = [...listCloudRunConnections(config)]
  const index = connections.findIndex((c) => c.projectName === connection.projectName)
  if (index === -1) connections.push(connection)
  else connections[index] = connection
  saveConnections(config, connections, persist)
  return connection
}

export function removeCloudRunConnection(
  config: CanonryConfig,
  projectName: string,
  persist?: PersistCloudRun,
): boolean {
  const connections = config.cloudRun?.connections
  if (!connections?.length) return false

  const next = connections.filter((c) => c.projectName !== projectName)
  if (next.length === connections.length) return false

  saveConnections(config, next, persist)
  return true
}
