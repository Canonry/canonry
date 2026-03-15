import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDashboard } from '../src/build-dashboard.js'
import type { ApiSettings } from '../src/api.js'

test('buildDashboard maps Google settings into the dashboard view model', () => {
  const apiSettings: ApiSettings = {
    providers: [{
      name: 'gemini',
      configured: true,
      model: 'gemini-3-flash',
    }],
    google: {
      configured: true,
    },
  }

  const dashboard = buildDashboard([], apiSettings)

  assert.equal(dashboard.settings.google.state, 'ready')
  assert.match(dashboard.settings.google.detail, /configured/i)
  assert.ok(
    dashboard.settings.selfHostNotes.some((note) => note.includes('source of truth for authentication credentials')),
  )
  assert.match(dashboard.settings.bootstrapNote, /Authentication credentials persist to local config/)
})

test('buildDashboard marks Google settings as needing config when OAuth is not configured', () => {
  const apiSettings: ApiSettings = {
    providers: [],
    google: {
      configured: false,
    },
  }

  const dashboard = buildDashboard([], apiSettings)

  assert.equal(dashboard.settings.google.state, 'needs-config')
  assert.match(dashboard.settings.google.detail, /not configured yet/i)
})
