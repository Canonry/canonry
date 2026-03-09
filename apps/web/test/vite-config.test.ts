import assert from 'node:assert/strict'
import test from 'node:test'

import config from '../vite.config.js'

test('vite dev server proxies API and worker health endpoints', () => {
  assert.equal(config.server?.proxy?.['/api-health']?.rewrite?.('/api-health'), '/health')
  assert.equal(config.server?.proxy?.['/worker-health']?.rewrite?.('/worker-health'), '/health')
})
