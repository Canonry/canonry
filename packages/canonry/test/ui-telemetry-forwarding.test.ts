import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ENV_KEYS = ['CANONRY_ANONYMOUS_ID', 'CANONRY_TELEMETRY_DISABLED', 'DO_NOT_TRACK', 'CI', 'CANONRY_CONFIG_DIR'] as const

const event = {
  event: 'ui.page_viewed',
  eventId: '30ed4717-c740-433f-9d37-05421e3f1a75',
  uiSessionId: '02db91c9-98d6-4826-b2cf-a9d4bec84768',
  page: '/projects/:projectName/report',
  tab: 'report',
}

describe('dashboard UI telemetry forwarding', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}
  let configDir: string
  let payloads: Array<Record<string, unknown>>
  let originalFetch: typeof fetch

  async function configure(telemetry: boolean) {
    const { saveConfig } = await import('../src/config.js')
    saveConfig({ apiUrl: 'http://localhost:4100', database: 'test.db', apiKey: 'cnry_test', telemetry, anonymousId: crypto.randomUUID() })
  }

  async function settle() {
    for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ui-telemetry-'))
    process.env.CANONRY_CONFIG_DIR = configDir
    payloads = []
    originalFetch = globalThis.fetch
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) payloads.push(JSON.parse(String(init.body)))
      return new Response('{}')
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  it('forwards the event as a dashboard event keyed by its eventId', async () => {
    await configure(true)
    const { recordDashboardEvent } = await import('../src/telemetry.js')
    recordDashboardEvent(event)
    await settle()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      event: 'ui.page_viewed',
      eventId: event.eventId,
      source: 'dashboard',
      properties: { uiSessionId: event.uiSessionId, page: event.page, tab: 'report' },
    })
    expect(payloads[0]!.properties).not.toHaveProperty('eventId')
  })

  it('sends nothing when telemetry is disabled in config', async () => {
    await configure(false)
    const { recordDashboardEvent } = await import('../src/telemetry.js')
    recordDashboardEvent(event)
    await settle()
    expect(payloads).toEqual([])
  })

  it('sends nothing under DO_NOT_TRACK', async () => {
    await configure(true)
    process.env.DO_NOT_TRACK = '1'
    const { recordDashboardEvent } = await import('../src/telemetry.js')
    recordDashboardEvent(event)
    await settle()
    expect(payloads).toEqual([])
  })
})
