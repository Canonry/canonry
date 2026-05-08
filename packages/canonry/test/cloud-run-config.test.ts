import { test, expect } from 'vitest'

import type { CanonryConfig } from '../src/config.js'
import {
  getCloudRunConnection,
  listCloudRunConnections,
  upsertCloudRunConnection,
  removeCloudRunConnection,
} from '../src/cloud-run-config.js'

function makeConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/canonry.db',
    apiKey: 'cnry_test',
  }
}

test('cloud-run config helpers persist a service-account connection scoped by project name', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertCloudRunConnection(config, {
    projectName: 'demo',
    gcpProjectId: 'openclaw-nyc',
    serviceName: 'openclaw-nyc',
    location: 'us-east1',
    authMode: 'service-account',
    clientEmail: 'sa@openclaw-nyc.iam.gserviceaccount.com',
    privateKey: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----',
    createdAt: now,
    updatedAt: now,
  })

  const conn = getCloudRunConnection(config, 'demo')
  expect(conn).toBeDefined()
  expect(conn?.gcpProjectId).toBe('openclaw-nyc')
  expect(conn?.authMode).toBe('service-account')
  expect(conn?.clientEmail).toBe('sa@openclaw-nyc.iam.gserviceaccount.com')
  expect(conn?.privateKey).toContain('PRIVATE KEY')
})

test('cloud-run config supports an OAuth-mode connection', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertCloudRunConnection(config, {
    projectName: 'demo',
    gcpProjectId: 'openclaw-nyc',
    authMode: 'oauth',
    refreshToken: 'rt_xxx',
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scopes: ['https://www.googleapis.com/auth/logging.read'],
    createdAt: now,
    updatedAt: now,
  })

  const conn = getCloudRunConnection(config, 'demo')
  expect(conn?.authMode).toBe('oauth')
  expect(conn?.refreshToken).toBe('rt_xxx')
  expect(conn?.scopes).toContain('https://www.googleapis.com/auth/logging.read')
  expect(conn?.privateKey).toBeUndefined()
})

test('upsertCloudRunConnection replaces the existing entry for the same project', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertCloudRunConnection(config, {
    projectName: 'demo',
    gcpProjectId: 'openclaw-nyc',
    authMode: 'service-account',
    clientEmail: 'sa1@x',
    privateKey: 'pk1',
    createdAt: now,
    updatedAt: now,
  })
  upsertCloudRunConnection(config, {
    projectName: 'demo',
    gcpProjectId: 'openclaw-nyc',
    authMode: 'service-account',
    clientEmail: 'sa2@x',
    privateKey: 'pk2',
    createdAt: now,
    updatedAt: now,
  })

  expect(listCloudRunConnections(config).length).toBe(1)
  expect(getCloudRunConnection(config, 'demo')?.clientEmail).toBe('sa2@x')
})

test('removeCloudRunConnection deletes the entry and prunes the empty cloudRun block', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertCloudRunConnection(config, {
    projectName: 'demo',
    gcpProjectId: 'openclaw-nyc',
    authMode: 'service-account',
    clientEmail: 'sa@x',
    privateKey: 'pk',
    createdAt: now,
    updatedAt: now,
  })

  expect(removeCloudRunConnection(config, 'demo')).toBe(true)
  expect(getCloudRunConnection(config, 'demo')).toBeUndefined()
  expect(config.cloudRun).toBeUndefined()
})

test('removeCloudRunConnection returns false when nothing to delete', () => {
  const config = makeConfig()
  expect(removeCloudRunConnection(config, 'demo')).toBe(false)
})
