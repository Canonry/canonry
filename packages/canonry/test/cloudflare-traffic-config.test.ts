import { describe, expect, it } from 'vitest'
import type { CanonryConfig, CloudflareTrafficConnectionConfigEntry } from '../src/config.js'
import {
  getCloudflareTrafficConnection,
  getCloudflareTrafficConnectionBySourceId,
  listCloudflareTrafficConnections,
  removeCloudflareTrafficConnection,
  upsertCloudflareTrafficConnection,
} from '../src/cloudflare-traffic-config.js'

function emptyConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:3001',
    database: ':memory:',
    apiKey: 'cnry_test',
  }
}

function makeEntry(overrides: Partial<CloudflareTrafficConnectionConfigEntry> = {}): CloudflareTrafficConnectionConfigEntry {
  return {
    projectName: 'demo',
    sourceId: 'src_abc',
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

describe('cloudflare-traffic-config', () => {
  describe('listCloudflareTrafficConnections', () => {
    it('returns [] when nothing is configured', () => {
      expect(listCloudflareTrafficConnections(emptyConfig())).toEqual([])
    })

    it('returns the configured connections', () => {
      const config = emptyConfig()
      config.cloudflareTraffic = { connections: [makeEntry()] }
      expect(listCloudflareTrafficConnections(config)).toHaveLength(1)
    })
  })

  describe('getCloudflareTrafficConnection', () => {
    it('returns undefined when no connection matches the project', () => {
      expect(getCloudflareTrafficConnection(emptyConfig(), 'demo')).toBeUndefined()
    })

    it('returns the connection by project name', () => {
      const config = emptyConfig()
      const entry = makeEntry({ projectName: 'demo' })
      config.cloudflareTraffic = { connections: [entry] }
      expect(getCloudflareTrafficConnection(config, 'demo')).toEqual(entry)
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
      const result = upsertCloudflareTrafficConnection(config, entry)
      expect(result).toEqual(entry)
      expect(config.cloudflareTraffic?.connections).toHaveLength(1)
    })

    it('replaces the existing entry when project names match', () => {
      const config = emptyConfig()
      config.cloudflareTraffic = { connections: [makeEntry({ bearerToken: 'old' })] }
      upsertCloudflareTrafficConnection(config, makeEntry({ bearerToken: 'new' }))
      expect(config.cloudflareTraffic.connections).toHaveLength(1)
      expect(config.cloudflareTraffic.connections?.[0]?.bearerToken).toBe('new')
    })

    it('initializes the block when cloudflareTraffic is missing', () => {
      const config = emptyConfig()
      upsertCloudflareTrafficConnection(config, makeEntry())
      expect(config.cloudflareTraffic?.connections).toHaveLength(1)
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
})
