import { test, expect } from 'vitest'

import type { CanonryConfig } from '../src/config.js'
import {
  getWordpressTrafficConnection,
  listWordpressTrafficConnections,
  upsertWordpressTrafficConnection,
  removeWordpressTrafficConnection,
} from '../src/wordpress-traffic-config.js'

function makeConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: '/tmp/canonry.db',
    apiKey: 'cnry_test',
  }
}

test('wordpress-traffic config helpers persist an application-password connection scoped by project name', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertWordpressTrafficConnection(config, {
    projectName: 'demo',
    baseUrl: 'https://example.com',
    username: 'canonry-bot',
    applicationPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
    createdAt: now,
    updatedAt: now,
  })

  const conn = getWordpressTrafficConnection(config, 'demo')
  expect(conn).toBeDefined()
  expect(conn?.baseUrl).toBe('https://example.com')
  expect(conn?.username).toBe('canonry-bot')
  expect(conn?.applicationPassword).toBe('xxxx xxxx xxxx xxxx xxxx xxxx')
})

test('upsertWordpressTrafficConnection replaces the existing entry for the same project', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertWordpressTrafficConnection(config, {
    projectName: 'demo',
    baseUrl: 'https://example.com',
    username: 'bot-1',
    applicationPassword: 'pw-1',
    createdAt: now,
    updatedAt: now,
  })
  upsertWordpressTrafficConnection(config, {
    projectName: 'demo',
    baseUrl: 'https://example.com',
    username: 'bot-2',
    applicationPassword: 'pw-2',
    createdAt: now,
    updatedAt: now,
  })

  expect(listWordpressTrafficConnections(config).length).toBe(1)
  expect(getWordpressTrafficConnection(config, 'demo')?.username).toBe('bot-2')
  expect(getWordpressTrafficConnection(config, 'demo')?.applicationPassword).toBe('pw-2')
})

test('removeWordpressTrafficConnection deletes the entry and prunes the empty wordpressTraffic block', () => {
  const config = makeConfig()
  const now = new Date().toISOString()

  upsertWordpressTrafficConnection(config, {
    projectName: 'demo',
    baseUrl: 'https://example.com',
    username: 'bot',
    applicationPassword: 'pw',
    createdAt: now,
    updatedAt: now,
  })

  expect(removeWordpressTrafficConnection(config, 'demo')).toBe(true)
  expect(getWordpressTrafficConnection(config, 'demo')).toBeUndefined()
  expect(config.wordpressTraffic).toBeUndefined()
})

test('removeWordpressTrafficConnection returns false when nothing to delete', () => {
  const config = makeConfig()
  expect(removeWordpressTrafficConnection(config, 'demo')).toBe(false)
})
