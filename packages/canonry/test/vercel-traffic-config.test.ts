import { test, expect } from 'vitest'

import type { CanonryConfig } from '../src/config.js'
import {
  getVercelTrafficConnection,
  listVercelTrafficConnections,
  upsertVercelTrafficConnection,
  removeVercelTrafficConnection,
} from '../src/vercel-traffic-config.js'

function makeConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/canonry.db',
    apiKey: 'cnry_test',
  }
}

test('vercel-traffic config helpers persist an API-token connection scoped by project name', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertVercelTrafficConnection(config, {
    projectName: 'demo',
    projectId: 'prj_abc',
    teamId: 'team_xyz',
    token: 'vcp_test_token',
    environment: 'production',
    createdAt: now,
    updatedAt: now,
  })

  const conn = getVercelTrafficConnection(config, 'demo')
  expect(conn).toBeDefined()
  expect(conn?.projectId).toBe('prj_abc')
  expect(conn?.teamId).toBe('team_xyz')
  expect(conn?.token).toBe('vcp_test_token')
  expect(conn?.environment).toBe('production')
})

test('upsertVercelTrafficConnection replaces the existing entry for the same project', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertVercelTrafficConnection(config, {
    projectName: 'demo',
    projectId: 'prj_old',
    teamId: 'team_old',
    token: 'token-1',
    environment: 'production',
    createdAt: now,
    updatedAt: now,
  })
  upsertVercelTrafficConnection(config, {
    projectName: 'demo',
    projectId: 'prj_new',
    teamId: 'team_new',
    token: 'token-2',
    environment: 'preview',
    createdAt: now,
    updatedAt: now,
  })

  expect(listVercelTrafficConnections(config).length).toBe(1)
  expect(getVercelTrafficConnection(config, 'demo')?.projectId).toBe('prj_new')
  expect(getVercelTrafficConnection(config, 'demo')?.token).toBe('token-2')
  expect(getVercelTrafficConnection(config, 'demo')?.environment).toBe('preview')
})

test('removeVercelTrafficConnection deletes the entry and prunes the empty vercelTraffic block', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertVercelTrafficConnection(config, {
    projectName: 'demo',
    projectId: 'prj_abc',
    teamId: 'team_xyz',
    token: 'vcp_test_token',
    environment: 'production',
    createdAt: now,
    updatedAt: now,
  })

  expect(removeVercelTrafficConnection(config, 'demo')).toBe(true)
  expect(getVercelTrafficConnection(config, 'demo')).toBeUndefined()
  expect(config.vercelTraffic).toBeUndefined()
})

test('removeVercelTrafficConnection returns false when nothing to delete', () => {
  const config = makeConfig()
  expect(removeVercelTrafficConnection(config, 'demo')).toBe(false)
})
