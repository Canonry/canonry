import assert from 'node:assert/strict'
import test from 'node:test'

import { createDatabaseClientPlaceholder, platformSchemaVersion } from '../src/index.js'

test('database placeholder exports remain stable', () => {
  assert.equal(platformSchemaVersion, 'phase-1-placeholder')
  assert.deepEqual(createDatabaseClientPlaceholder(), {
    kind: 'database-client-placeholder',
    status: 'unconfigured',
  })
})
