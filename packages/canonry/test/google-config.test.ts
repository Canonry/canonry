import test from 'node:test'
import assert from 'node:assert/strict'

import type { CanonryConfig } from '../src/config.js'
import {
  getGoogleConnection,
  listGoogleConnections,
  patchGoogleConnection,
  removeGoogleConnection,
  setGoogleAuthConfig,
  upsertGoogleConnection,
} from '../src/google-config.js'

function makeConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/canonry.db',
    apiKey: 'cnry_test',
  }
}

test('google config helpers store auth credentials and domain-scoped connections in local config', () => {
  const config = makeConfig()
  setGoogleAuthConfig(config, {
    clientId: 'google-client-id',
    clientSecret: 'google-client-secret',
  })

  const createdAt = new Date().toISOString()
  upsertGoogleConnection(config, {
    domain: 'example.com',
    connectionType: 'gsc',
    propertyId: 'sc-domain:example.com',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scopes: ['scope-1'],
    createdAt,
    updatedAt: createdAt,
  })

  const conn = getGoogleConnection(config, 'example.com', 'gsc')
  assert.ok(conn)
  assert.equal(conn.propertyId, 'sc-domain:example.com')
  assert.equal(conn.refreshToken, 'refresh-token')
  assert.deepEqual(listGoogleConnections(config, 'example.com').map((entry) => entry.connectionType), ['gsc'])

  const updated = patchGoogleConnection(config, 'example.com', 'gsc', {
    accessToken: 'new-access-token',
    updatedAt: new Date().toISOString(),
  })
  assert.ok(updated)
  assert.equal(updated.accessToken, 'new-access-token')

  assert.equal(removeGoogleConnection(config, 'example.com', 'gsc'), true)
  assert.equal(getGoogleConnection(config, 'example.com', 'gsc'), undefined)
})
