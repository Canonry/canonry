import type {
  CanonryConfig,
  GoogleConnectionConfigEntry,
  GoogleConnectionType,
} from './config.js'

function ensureConnections(config: CanonryConfig): GoogleConnectionConfigEntry[] {
  if (!config.google) config.google = {}
  if (!config.google.connections) config.google.connections = []
  return config.google.connections
}

export function getGoogleAuthConfig(config: CanonryConfig): {
  clientId?: string
  clientSecret?: string
} {
  return {
    clientId: config.google?.clientId,
    clientSecret: config.google?.clientSecret,
  }
}

export function setGoogleAuthConfig(
  config: CanonryConfig,
  auth: { clientId?: string; clientSecret?: string },
): void {
  const hasValues = Boolean(auth.clientId || auth.clientSecret || config.google?.connections?.length)
  if (!hasValues) {
    delete config.google
    return
  }

  if (!config.google) config.google = {}
  config.google.clientId = auth.clientId
  config.google.clientSecret = auth.clientSecret
  config.google.connections = config.google.connections ?? []
}

export function listGoogleConnections(
  config: CanonryConfig,
  domain: string,
): GoogleConnectionConfigEntry[] {
  return (config.google?.connections ?? []).filter((connection) => connection.domain === domain)
}

export function getGoogleConnection(
  config: CanonryConfig,
  domain: string,
  connectionType: GoogleConnectionType,
): GoogleConnectionConfigEntry | undefined {
  return (config.google?.connections ?? []).find((connection) => (
    connection.domain === domain && connection.connectionType === connectionType
  ))
}

export function upsertGoogleConnection(
  config: CanonryConfig,
  connection: GoogleConnectionConfigEntry,
): GoogleConnectionConfigEntry {
  const connections = ensureConnections(config)
  const index = connections.findIndex((entry) => (
    entry.domain === connection.domain && entry.connectionType === connection.connectionType
  ))
  const normalized: GoogleConnectionConfigEntry = {
    ...connection,
    propertyId: connection.propertyId ?? null,
    refreshToken: connection.refreshToken ?? null,
    tokenExpiresAt: connection.tokenExpiresAt ?? null,
    scopes: connection.scopes ?? [],
  }

  if (index === -1) {
    connections.push(normalized)
    return normalized
  }

  connections[index] = normalized
  return normalized
}

export function patchGoogleConnection(
  config: CanonryConfig,
  domain: string,
  connectionType: GoogleConnectionType,
  patch: Partial<Omit<GoogleConnectionConfigEntry, 'domain' | 'connectionType' | 'createdAt'>>,
): GoogleConnectionConfigEntry | undefined {
  const existing = getGoogleConnection(config, domain, connectionType)
  if (!existing) return undefined

  return upsertGoogleConnection(config, {
    ...existing,
    ...patch,
    propertyId: Object.prototype.hasOwnProperty.call(patch, 'propertyId')
      ? patch.propertyId ?? null
      : existing.propertyId ?? null,
    refreshToken: Object.prototype.hasOwnProperty.call(patch, 'refreshToken')
      ? patch.refreshToken ?? null
      : existing.refreshToken ?? null,
    tokenExpiresAt: Object.prototype.hasOwnProperty.call(patch, 'tokenExpiresAt')
      ? patch.tokenExpiresAt ?? null
      : existing.tokenExpiresAt ?? null,
    scopes: patch.scopes ?? existing.scopes ?? [],
  })
}

export function removeGoogleConnection(
  config: CanonryConfig,
  domain: string,
  connectionType: GoogleConnectionType,
): boolean {
  const connections = config.google?.connections
  if (!connections?.length) return false

  const next = connections.filter((connection) => (
    connection.domain !== domain || connection.connectionType !== connectionType
  ))
  if (next.length === connections.length) return false

  if (!config.google) return false
  config.google.connections = next
  if (!config.google.clientId && !config.google.clientSecret && next.length === 0) {
    delete config.google
  }
  return true
}
