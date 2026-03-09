import assert from 'node:assert/strict'
import test from 'node:test'

import config from '../vite.config.js'

test('vite dev server proxies API routes and health endpoint', () => {
  assert.ok(config.server?.proxy?.['/api/v1'], 'should proxy /api/v1 requests')
  assert.ok(config.server?.proxy?.['/health'], 'should proxy /health requests')
})
