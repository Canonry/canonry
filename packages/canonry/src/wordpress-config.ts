import type { CanonryConfig, WordpressConnectionConfigEntry, WordpressEnv } from './config.js'

function ensureConnections(config: CanonryConfig): WordpressConnectionConfigEntry[] {
  if (!config.wordpress) config.wordpress = {}
  if (!config.wordpress.connections) config.wordpress.connections = []
  return config.wordpress.connections
}

function normalizeConnection(
  connection: WordpressConnectionConfigEntry,
): WordpressConnectionConfigEntry {
  return {
    ...connection,
    url: connection.url.replace(/\/$/, ''),
    stagingUrl: connection.stagingUrl?.replace(/\/$/, ''),
    defaultEnv: connection.defaultEnv ?? 'live',
  }
}

export function getWordpressConnection(
  config: CanonryConfig,
  projectName: string,
): WordpressConnectionConfigEntry | undefined {
  return (config.wordpress?.connections ?? []).find((connection) => connection.projectName === projectName)
}

export function upsertWordpressConnection(
  config: CanonryConfig,
  connection: WordpressConnectionConfigEntry,
): WordpressConnectionConfigEntry {
  const connections = ensureConnections(config)
  const normalized = normalizeConnection(connection)
  const index = connections.findIndex((entry) => entry.projectName === connection.projectName)

  if (index === -1) {
    connections.push(normalized)
    return normalized
  }

  connections[index] = normalized
  return normalized
}

export function patchWordpressConnection(
  config: CanonryConfig,
  projectName: string,
  patch: Partial<Omit<WordpressConnectionConfigEntry, 'projectName' | 'createdAt'>>,
): WordpressConnectionConfigEntry | undefined {
  const existing = getWordpressConnection(config, projectName)
  if (!existing) return undefined

  return upsertWordpressConnection(config, {
    ...existing,
    ...patch,
    stagingUrl: Object.prototype.hasOwnProperty.call(patch, 'stagingUrl')
      ? patch.stagingUrl
      : existing.stagingUrl,
    defaultEnv: (patch.defaultEnv ?? existing.defaultEnv ?? 'live') as WordpressEnv,
  })
}

export function removeWordpressConnection(
  config: CanonryConfig,
  projectName: string,
): boolean {
  const connections = config.wordpress?.connections
  if (!connections?.length) return false

  const next = connections.filter((connection) => connection.projectName !== projectName)
  if (next.length === connections.length) return false

  if (!config.wordpress) return false
  config.wordpress.connections = next
  if (next.length === 0) {
    delete config.wordpress
  }
  return true
}
