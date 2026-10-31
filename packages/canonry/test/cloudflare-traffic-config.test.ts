import { describe, expect, it } from 'vitest'
import type {
  CanonryConfig,
  CloudflareDirectPushConnectionConfigEntry,
  CloudflareQueuePullConnectionConfigEntry,
  CloudflareTrafficConnectionConfigEntry,
} from '../src/config.js'
import {
  getCloudflareTrafficConnection,
  getCloudflareTrafficConnectionBySourceId,
  removeCloudflareTrafficConnection,
  removeCloudflareTrafficConnectionBySourceId,
  upsertCloudflareTrafficConnection,
} from '../src/cloudflare-traffic-config.js'

function emptyConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:3001',
    database: ':memory:',
    apiKey: 'cnry_test',
  }
}

function makeEntry(overrides: Partial<CloudflareDirectPushConnectionConfigEntry> = {}): CloudflareDirectPushConnectionConfigEntry {
  return {
    projectName: 'demo',
    sourceId: 'src_abc',
    deliveryMode: 'direct-push',
    bearerToken: 'tok_secret',
    hmacSecret: 'hmac_secret',
    workerVersion: '1.0.0',
    expectedBotListVersion: '2026-05-27',
    zoneId: null,
    accountId: null,
    createdAt: '2026-05-27T00:00:00Z',
    updatedAt: '2026-05-27T00:00:00Z',
    ...overrides,
  }
}

function makeQueueEntry(
  overrides: Partial<CloudflareQueuePullConnectionConfigEntry> = {},
): CloudflareQueuePullConnectionConfigEntry {
  return {
    projectName: 'demo',
    sourceId: 'src_queue',
    deliveryMode: 'queue-pull',
    apiToken: 'queue_secret',
    workerVersion: '1.0.0',
    expectedBotListVersion: '2026-05-27',
    zoneId: 'zone_abc',
    accountId: 'account_abc',
    queueId: 'queue_abc',
    queueName: 'canonry-demo',
    retentionSeconds: 86_400,
    createdAt: '2026-05-27T00:00:00Z',
    updatedAt: '2026-05-27T00:00:00Z',
    ...overrides,
  }
}

describe('cloudflare-traffic-config', () => {
  describe('getCloudflareTrafficConnection', () => {
    it('returns undefined when no connection matches the project', () => {
      expect(getCloudflareTrafficConnection(emptyConfig(), 'demo')).toBeUndefined()
    })

    it('returns the connection by project name', () => {
      const config = emptyConfig()
      config.cloudflareTraffic = { connections: [
        makeEntry({ projectName: 'other', sourceId: 'src_other', bearerToken: 'other_token', hmacSecret: 'other_hmac' }),
        makeEntry({ projectName: 'demo', sourceId: 'src_demo', bearerToken: 'demo_token', hmacSecret: 'demo_hmac' }),
      ] }
      expect(getCloudflareTrafficConnection(config, 'demo')).toEqual({
        projectName: 'demo', sourceId: 'src_demo', deliveryMode: 'direct-push',
        bearerToken: 'demo_token', hmacSecret: 'demo_hmac', workerVersion: '1.0.0',
        expectedBotListVersion: '2026-05-27', zoneId: null, accountId: null,
        createdAt: '2026-05-27T00:00:00Z', updatedAt: '2026-05-27T00:00:00Z',
      })
      expect(getCloudflareTrafficConnection(config, 'unknown')).toBeUndefined()
    })

    it('normalizes a legacy connection with no delivery mode to direct-push', () => {
      const config = emptyConfig()
      const legacy: Omit<CloudflareDirectPushConnectionConfigEntry, 'deliveryMode'> & { deliveryMode?: 'direct-push' } = makeEntry()
      delete legacy.deliveryMode
      config.cloudflareTraffic = { connections: [legacy as CloudflareTrafficConnectionConfigEntry] }

      expect(getCloudflareTrafficConnection(config, 'demo')?.deliveryMode).toBe('direct-push')
    })

    it('returns a queue-pull connection without coercing its mode', () => {
      const config = emptyConfig()
      const queue = makeQueueEntry()
      config.cloudflareTraffic = { connections: [queue] }

      expect(getCloudflareTrafficConnection(config, 'demo')).toEqual(queue)
    })

    it.each([59, 1.5, 1_209_601])(
      'rejects an invalid Queue retention of %s seconds',
      (retentionSeconds) => {
        const config = emptyConfig()
        config.cloudflareTraffic = {
          connections: [makeQueueEntry({ retentionSeconds })],
        }

        expect(() => getCloudflareTrafficConnection(config, 'demo'))
          .toThrow(/invalid.*queue-pull/i)
      },
    )

    it('rejects a Queue name that Cloudflare cannot create', () => {
      const config = emptyConfig()
      config.cloudflareTraffic = {
        connections: [makeQueueEntry({ queueName: 'unsafe queue name' })],
      }

      expect(() => getCloudflareTrafficConnection(config, 'demo'))
        .toThrow(/invalid.*queue-pull/i)
    })

    it('rejects an unsupported transport instead of treating it as direct-push', () => {
      const config = emptyConfig()
      const unsupported = {
        ...makeEntry(),
        deliveryMode: 'webhook-push',
      } as unknown as CloudflareTrafficConnectionConfigEntry
      config.cloudflareTraffic = { connections: [unsupported] }

      expect(() => getCloudflareTrafficConnection(config, 'demo')).toThrow(/unsupported.*webhook-push/i)
    })
  })

  describe('getCloudflareTrafficConnectionBySourceId', () => {
    it('returns the connection paired with the source id', () => {
      const config = emptyConfig()
      const entry = makeEntry({ sourceId: 'src_xyz' })
      config.cloudflareTraffic = { connections: [makeEntry({ sourceId: 'src_abc' }), entry] }
      expect(getCloudflareTrafficConnectionBySourceId(config, 'src_xyz')).toEqual(entry)
    })

    it('returns undefined when the source id is unknown', () => {
      const config = emptyConfig()
      config.cloudflareTraffic = { connections: [makeEntry()] }
      expect(getCloudflareTrafficConnectionBySourceId(config, 'src_unknown')).toBeUndefined()
    })
  })

  describe('upsertCloudflareTrafficConnection', () => {
    it('appends when no entry exists for the project', () => {
      const config = emptyConfig()
      const entry = makeEntry()
      const expected = {
        projectName: 'demo', sourceId: 'src_abc', deliveryMode: 'direct-push',
        bearerToken: 'tok_secret', hmacSecret: 'hmac_secret', workerVersion: '1.0.0',
        expectedBotListVersion: '2026-05-27', zoneId: null, accountId: null,
        createdAt: '2026-05-27T00:00:00Z', updatedAt: '2026-05-27T00:00:00Z',
      }
      const result = upsertCloudflareTrafficConnection(config, entry)
      expect(result).toEqual(expected)
      expect(config.cloudflareTraffic).toEqual({ connections: [expected] })
    })

    it('replaces the existing entry when source ids match', () => {
      const config = emptyConfig()
      config.cloudflareTraffic = { connections: [makeEntry({ bearerToken: 'old' })] }
      upsertCloudflareTrafficConnection(config, makeEntry({ bearerToken: 'new' }))
      expect(config.cloudflareTraffic.connections).toHaveLength(1)
      expect(config.cloudflareTraffic.connections?.[0]).toMatchObject({
        deliveryMode: 'direct-push',
        bearerToken: 'new',
      })
    })

    it('retains staged credentials for two source ids in the same project', () => {
      const config = emptyConfig()
      upsertCloudflareTrafficConnection(config, makeEntry({ sourceId: 'src_push' }))
      upsertCloudflareTrafficConnection(config, makeQueueEntry({ sourceId: 'src_queue' }))

      expect(config.cloudflareTraffic?.connections?.map((entry) => entry.sourceId)).toEqual([
        'src_push',
        'src_queue',
      ])
    })

  })

  describe('removeCloudflareTrafficConnection', () => {
    it('returns false when no entry exists', () => {
      expect(removeCloudflareTrafficConnection(emptyConfig(), 'demo')).toBe(false)
    })

    it('removes the matching entry and returns true', () => {
      const config = emptyConfig()
      config.cloudflareTraffic = { connections: [makeEntry({ projectName: 'a' }), makeEntry({ projectName: 'b' })] }
      expect(removeCloudflareTrafficConnection(config, 'a')).toBe(true)
      expect(config.cloudflareTraffic?.connections?.[0]?.projectName).toBe('b')
    })

    it('clears the cloudflareTraffic block when the last entry is removed', () => {
      const config = emptyConfig()
      config.cloudflareTraffic = { connections: [makeEntry({ projectName: 'a' })] }
      expect(removeCloudflareTrafficConnection(config, 'a')).toBe(true)
      expect(config.cloudflareTraffic).toBeUndefined()
    })
  })

  describe('removeCloudflareTrafficConnectionBySourceId', () => {
    it('removes only the requested staged credential', () => {
      const config = emptyConfig()
      config.cloudflareTraffic = {
        connections: [makeEntry({ sourceId: 'src_push' }), makeQueueEntry({ sourceId: 'src_queue' })],
      }

      expect(removeCloudflareTrafficConnectionBySourceId(config, 'src_queue')).toBe(true)
      expect(config.cloudflareTraffic?.connections?.map((entry) => entry.sourceId)).toEqual(['src_push'])
    })
  })
})
