import type { CanonryConfig, WordpressTrafficConnectionConfigEntry } from './config.js'

function ensureConnections(config: CanonryConfig): WordpressTrafficConnectionConfigEntry[] {
  if (!config.wordpressTraffic) config.wordpressTraffic = {}
  if (!config.wordpressTraffic.connections) config.wordpressTraffic.connections = []
  return config.wordpressTraffic.connections
}

export function listWordpressTrafficConnections(
  config: CanonryConfig,
): WordpressTrafficConnectionConfigEntry[] {
  return config.wordpressTraffic?.connections ?? []
}

export function getWordpressTrafficConnection(
  config: CanonryConfig,
  projectName: string,
): WordpressTrafficConnectionConfigEntry | undefined {
  return (config.wordpressTraffic?.connections ?? []).find((c) => c.projectName === projectName)
}

export function upsertWordpressTrafficConnection(
  config: CanonryConfig,
  connection: WordpressTrafficConnectionConfigEntry,
): WordpressTrafficConnectionConfigEntry {
  const connections = ensureConnections(config)
  const index = connections.findIndex((c) => c.projectName === connection.projectName)

  if (index === -1) {
    connections.push(connection)
    return connection
  }

  connections[index] = connection
  return connection
}

export function removeWordpressTrafficConnection(
  config: CanonryConfig,
  projectName: string,
): boolean {
  const connections = config.wordpressTraffic?.connections
  if (!connections?.length) return false

  const next = connections.filter((c) => c.projectName !== projectName)
  if (next.length === connections.length) return false

  if (!config.wordpressTraffic) return false
  config.wordpressTraffic.connections = next
  if (next.length === 0) {
    delete config.wordpressTraffic
  }
  return true
}
