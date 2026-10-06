import type { CanonryConfig, CloudflareTrafficConnectionConfigEntry } from './config.js'
import { cloudflareQueueNameSchema } from '@ainyc/canonry-contracts'

function unsupportedDeliveryMode(deliveryMode: unknown): Error {
  const label = typeof deliveryMode === 'string' ? ` "${deliveryMode}"` : ''
  return new Error(`Unsupported Cloudflare traffic delivery mode${label}`)
}

function ensureConnections(config: CanonryConfig): CloudflareTrafficConnectionConfigEntry[] {
  if (!config.cloudflareTraffic) config.cloudflareTraffic = {}
  if (!config.cloudflareTraffic.connections) config.cloudflareTraffic.connections = []
  return config.cloudflareTraffic.connections
}

function normalizeCloudflareTrafficConnection(
  connection: CloudflareTrafficConnectionConfigEntry,
): CloudflareTrafficConnectionConfigEntry {
  const deliveryMode = (connection as { deliveryMode?: unknown }).deliveryMode
  if (deliveryMode === 'queue-pull') {
    const queue = connection as CloudflareTrafficConnectionConfigEntry & {
      apiToken?: unknown
      queueId?: unknown
      queueName?: unknown
      retentionSeconds?: unknown
    }
    if (
      typeof queue.apiToken !== 'string'
      || queue.apiToken.length === 0
      || typeof queue.accountId !== 'string'
      || queue.accountId.length === 0
      || typeof queue.queueId !== 'string'
      || queue.queueId.length === 0
      || typeof queue.queueName !== 'string'
      || !cloudflareQueueNameSchema.safeParse(queue.queueName).success
      || typeof queue.retentionSeconds !== 'number'
      || !Number.isInteger(queue.retentionSeconds)
      || queue.retentionSeconds < 60
      || queue.retentionSeconds > 1_209_600
    ) {
      throw new Error('Invalid Cloudflare queue-pull credential configuration')
    }
    return connection
  }
  if (deliveryMode === 'direct-push') return connection
  if (deliveryMode === undefined) {
    return { ...connection, deliveryMode: 'direct-push' } as CloudflareTrafficConnectionConfigEntry
  }
  throw unsupportedDeliveryMode(deliveryMode)
}

export function getCloudflareTrafficConnection(
  config: CanonryConfig,
  projectName: string,
): CloudflareTrafficConnectionConfigEntry | undefined {
  const connection = (config.cloudflareTraffic?.connections ?? []).find((c) => c.projectName === projectName)
  return connection ? normalizeCloudflareTrafficConnection(connection) : undefined
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
  const connection = (config.cloudflareTraffic?.connections ?? []).find((c) => c.sourceId === sourceId)
  return connection ? normalizeCloudflareTrafficConnection(connection) : undefined
}

export function upsertCloudflareTrafficConnection(
  config: CanonryConfig,
  connection: CloudflareTrafficConnectionConfigEntry,
): CloudflareTrafficConnectionConfigEntry {
  normalizeCloudflareTrafficConnection(connection)
  const connections = ensureConnections(config)
  const index = connections.findIndex((c) => c.sourceId === connection.sourceId)

  if (index === -1) {
    connections.push(connection)
    return connection
  }

  connections[index] = connection
  return connection
}

export function removeCloudflareTrafficConnectionBySourceId(
  config: CanonryConfig,
  sourceId: string,
): boolean {
  const connections = config.cloudflareTraffic?.connections
  if (!connections?.length) return false

  const next = connections.filter((c) => c.sourceId !== sourceId)
  if (next.length === connections.length) return false

  if (!config.cloudflareTraffic) return false
  config.cloudflareTraffic.connections = next
  if (next.length === 0) delete config.cloudflareTraffic
  return true
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
