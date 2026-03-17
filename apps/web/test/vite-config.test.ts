import { test, expect } from 'vitest'

import config from '../vite.config.js'

test('vite dev server proxies API routes and health endpoint', () => {
  expect(config.server?.proxy?.['/api/v1']).toBeTruthy()
  expect(config.server?.proxy?.['/health']).toBeTruthy()
})
