import { afterEach, expect, test } from 'vitest'
import type { UiTelemetryEvent } from '@ainyc/canonry-contracts'
import { sendTestNotification } from '../src/api.js'
import { configureUiTelemetry, recordUiApiResult, resetUiTelemetryForTests } from '../src/lib/ui-telemetry.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => resetUiTelemetryForTests())

function captureActions() {
  const sent: UiTelemetryEvent[] = []
  configureUiTelemetry({ send: async (event) => { sent.push(event); return { accepted: true } } })
  return () => sent.flatMap(event => event.event === 'ui.action' ? [event.action] : [])
}

test('counts a notification test only when the destination accepted it', async () => {
  const actions = captureActions()
  const answers = [{ status: 500, ok: false }, { status: 0, ok: false }, { status: 204, ok: true }]
  const paths: string[] = []
  const restore = mockFetch((url) => {
    paths.push(pathOf(url))
    return jsonResponse(answers.shift())
  })
  try {
    // The route answers 200 with ok:false when the destination refused or never answered.
    expect(await sendTestNotification('acme', 'hook-1')).toEqual({ status: 500, ok: false })
    expect(await sendTestNotification('acme', 'hook-1')).toEqual({ status: 0, ok: false })
    expect(actions()).toEqual([])

    expect(await sendTestNotification('acme', 'hook-1')).toEqual({ status: 204, ok: true })
    expect(actions()).toEqual(['notification.test'])
    expect(paths).toEqual(Array(3).fill('/api/v1/projects/acme/notifications/hook-1/test'))
  } finally {
    restore()
  }
})

test('a 200 from the test route alone is not a notification.test action', () => {
  const actions = captureActions()
  recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/notifications/{id}/test', status: 200 })
  recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/notifications', status: 201 })
  expect(actions()).toEqual(['notification.save'])
})
