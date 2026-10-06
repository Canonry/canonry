import { test, expect } from 'vitest'

import { describeAuditClient } from '../src/audit-client.js'

test('audit client descriptor identifies the published npm package boundary', () => {
  expect(describeAuditClient()).toBe('@ainyc/aeo-audit via npm')
})
