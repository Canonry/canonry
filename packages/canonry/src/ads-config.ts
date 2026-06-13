import type { CanonryConfig, OpenAiAdsConnectionConfigEntry } from './config.js'

function ensureConnections(config: CanonryConfig): OpenAiAdsConnectionConfigEntry[] {
  if (!config.openaiAds) config.openaiAds = {}
  if (!config.openaiAds.connections) config.openaiAds.connections = []
  return config.openaiAds.connections
}

export function getOpenAiAdsConnection(
  config: CanonryConfig,
  projectName: string,
): OpenAiAdsConnectionConfigEntry | undefined {
  return (config.openaiAds?.connections ?? []).find((c) => c.projectName === projectName)
}

export function upsertOpenAiAdsConnection(
  config: CanonryConfig,
  connection: OpenAiAdsConnectionConfigEntry,
): OpenAiAdsConnectionConfigEntry {
  const connections = ensureConnections(config)
  const index = connections.findIndex((c) => c.projectName === connection.projectName)

  if (index === -1) {
    connections.push(connection)
    return connection
  }

  connections[index] = connection
  return connection
}

export function removeOpenAiAdsConnection(
  config: CanonryConfig,
  projectName: string,
): boolean {
  const connections = config.openaiAds?.connections
  if (!connections?.length) return false

  const next = connections.filter((c) => c.projectName !== projectName)
  if (next.length === connections.length) return false

  if (!config.openaiAds) return false
  config.openaiAds.connections = next
  if (next.length === 0) {
    delete config.openaiAds
  }
  return true
}
