import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UiTelemetryEvent } from '@ainyc/canonry-contracts'
import { uiTelemetryEventSchema } from '@ainyc/canonry-contracts'
import {
  configureUiTelemetry,
  recordUiApiResult,
  recordUiError,
  resetUiTelemetryForTests,
  setUiPageFromRoute,
  trackUiAction,
  UI_TELEMETRY_MAX_PER_MINUTE,
} from '../src/lib/ui-telemetry.js'

afterEach(() => resetUiTelemetryForTests())

function capture(accepted = true) {
  const sent: UiTelemetryEvent[] = []
  let clock = 0
  configureUiTelemetry({
    send: async (event) => { sent.push(event); return { accepted } },
    now: () => clock,
  })
  return { sent, advance: (ms: number) => { clock += ms } }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ui telemetry', () => {
  it('sends nothing until configured', () => {
    const send = vi.fn()
    setUiPageFromRoute('/projects/$projectName/report')
    trackUiAction('sweep.launch')
    expect(send).not.toHaveBeenCalled()
  })

  it('reports route patterns, never real names, once per page and tab per session', () => {
    const { sent } = capture()
    setUiPageFromRoute('/projects/$projectName/report')
    setUiPageFromRoute('/projects/$projectName/report')
    setUiPageFromRoute('/projects/$projectName/')
    expect(sent.map(e => [e.event, e.page, e.tab])).toEqual([
      ['ui.page_viewed', '/projects/:projectName/report', 'report'],
      ['ui.page_viewed', '/projects/:projectName', 'overview'],
    ])
    for (const event of sent) expect(uiTelemetryEventSchema.safeParse(event).success).toBe(true)
  })

  it('caps each tab at the per-minute limit', () => {
    const { sent, advance } = capture()
    for (let i = 0; i < UI_TELEMETRY_MAX_PER_MINUTE + 10; i += 1) trackUiAction('aero.send')
    expect(sent).toHaveLength(UI_TELEMETRY_MAX_PER_MINUTE)
    advance(61_000)
    trackUiAction('aero.send')
    expect(sent).toHaveLength(UI_TELEMETRY_MAX_PER_MINUTE + 1)
  })

  it('reports an error by class name only and dedupes it', () => {
    const { sent } = capture()
    setUiPageFromRoute('/runs')
    const error = new TypeError('Cannot read properties of undefined (reading "acme-secret-project")')
    recordUiError({ kind: 'render', error, component: 'root' })
    recordUiError({ kind: 'render', error, component: 'root' })
    const errors = sent.filter(e => e.event === 'ui.error')
    expect(errors).toEqual([expect.objectContaining({ kind: 'render', errorName: 'TypeError', component: 'root', page: '/runs' })])
    expect(JSON.stringify(sent)).not.toContain('acme-secret-project')
  })

  it('drops an error name that is not identifier-shaped', () => {
    const { sent } = capture()
    recordUiError({ kind: 'unhandled', error: { name: 'free text with spaces' } })
    expect(sent[0]).toMatchObject({ event: 'ui.error', kind: 'unhandled' })
    expect(sent[0]).not.toHaveProperty('errorName')
  })

  it('maps successful dashboard writes to actions and failures to api errors by template', () => {
    const { sent } = capture()
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/runs', status: 201 })
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/ga/connect', status: 200 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}/runs', status: 200 })
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/queries/generate', status: 429 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}', status: 401 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/settings', network: true })
    recordUiApiResult({ method: 'POST', route: '/api/v1/telemetry/ui', status: 500 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/acme-co/runs', status: 500 })
    expect(sent.map(e => e.event === 'ui.action'
      ? ['action', e.action, e.integration]
      : e.event === 'ui.error' ? ['error', e.route, e.statusClass, e.status] : [e.event])).toEqual([
      ['action', 'sweep.launch', undefined],
      ['action', 'integration.connect', 'ga'],
      ['error', '/api/v1/projects/{name}/queries/generate', '4xx', 429],
      ['error', '/api/v1/settings', 'network', undefined],
    ])
    for (const event of sent) expect(uiTelemetryEventSchema.safeParse(event).success).toBe(true)
  })

  it('stops sending for the session once the server says it does not collect', async () => {
    const { sent } = capture(false)
    trackUiAction('aero.open')
    await flush()
    trackUiAction('aero.send')
    expect(sent.map(e => e.event === 'ui.action' && e.action)).toEqual(['aero.open'])
  })

  it('never throws into the UI when the sender fails', async () => {
    configureUiTelemetry({ send: async () => { throw new Error('offline') } })
    expect(() => trackUiAction('sweep.launch')).not.toThrow()
    await flush()
  })
})
