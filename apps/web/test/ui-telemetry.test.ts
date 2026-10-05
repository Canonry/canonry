import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UiTelemetryEvent } from '@ainyc/canonry-contracts'
import { uiTelemetryEventSchema } from '@ainyc/canonry-contracts'
import {
  configureUiTelemetry,
  recordUiApiResult,
  recordUiError,
  recordUiVital,
  resetUiTelemetryForTests,
  setUiPageFromRoute,
  trackUiAction,
  UI_TELEMETRY_MAX_PER_HOUR,
  UI_TELEMETRY_MAX_PER_MINUTE,
} from '../src/lib/ui-telemetry.js'
import { createClsAccumulator, createInpAccumulator, rateVital, sendUiTelemetryEvent } from '../src/lib/ui-telemetry-install.js'

afterEach(() => {
  resetUiTelemetryForTests()
  vi.unstubAllGlobals()
})

function capture(options: { accepted?: boolean; start?: number } = {}) {
  const sent: UiTelemetryEvent[] = []
  let clock = options.start ?? 1_000_000
  configureUiTelemetry({
    send: async (event) => { sent.push(event); return { accepted: options.accepted ?? true } },
    now: () => clock,
  })
  return { sent, advance: (ms: number) => { clock += ms } }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const actions = (sent: UiTelemetryEvent[]) => sent.flatMap(e => e.event === 'ui.action' ? [[e.action, e.integration]] : [])
const errors = (sent: UiTelemetryEvent[]) => sent.flatMap(e => e.event === 'ui.error' ? [[e.route, e.status ?? e.statusClass]] : [])

describe('ui telemetry', () => {
  it('sends nothing until configured', () => {
    setUiPageFromRoute('/projects/$projectName/report')
    trackUiAction('sweep.launch')
    expect(() => trackUiAction('sweep.launch')).not.toThrow()
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

  it('caps each tab at 30 a minute', () => {
    const { sent, advance } = capture()
    for (let i = 0; i < UI_TELEMETRY_MAX_PER_MINUTE + 10; i += 1) trackUiAction('aero.send')
    expect(sent).toHaveLength(UI_TELEMETRY_MAX_PER_MINUTE)
    advance(61_000)
    trackUiAction('aero.send')
    expect(sent).toHaveLength(UI_TELEMETRY_MAX_PER_MINUTE + 1)
  })

  it('caps each tab at 120 an hour, and a reload does not reset it', () => {
    const { sent, advance } = capture()
    for (let minute = 0; minute < 5; minute += 1) {
      for (let i = 0; i < UI_TELEMETRY_MAX_PER_MINUTE; i += 1) trackUiAction('aero.send')
      advance(61_000)
    }
    expect(sent).toHaveLength(UI_TELEMETRY_MAX_PER_HOUR)

    resetUiTelemetryForTests({ keepStorage: true })
    const reloaded = capture({ start: 1_000_000 + 5 * 61_000 })
    trackUiAction('aero.send')
    expect(reloaded.sent).toHaveLength(0)
    reloaded.advance(3_600_000)
    trackUiAction('aero.send')
    expect(reloaded.sent).toHaveLength(1)
  })

  it('does not mark a page view seen when the cap dropped it, so it is sent later', () => {
    const { sent, advance } = capture()
    for (let i = 0; i < UI_TELEMETRY_MAX_PER_MINUTE; i += 1) trackUiAction('aero.send')
    setUiPageFromRoute('/runs')
    expect(sent.some(e => e.event === 'ui.page_viewed')).toBe(false)
    advance(61_000)
    setUiPageFromRoute('/runs')
    expect(sent.filter(e => e.event === 'ui.page_viewed').map(e => e.page)).toEqual(['/runs'])
  })

  it('reports an error by class name only and dedupes it', () => {
    const { sent } = capture()
    setUiPageFromRoute('/runs')
    const error = new TypeError('Cannot read properties of undefined (reading "acme-secret-project")')
    recordUiError({ kind: 'render', error, component: 'root' })
    recordUiError({ kind: 'render', error, component: 'root' })
    expect(sent.filter(e => e.event === 'ui.error')).toEqual([
      expect.objectContaining({ kind: 'render', errorName: 'TypeError', component: 'root', page: '/runs' }),
    ])
    expect(JSON.stringify(sent)).not.toContain('acme-secret-project')
  })

  it('drops an error name that is not identifier-shaped', () => {
    const { sent } = capture()
    recordUiError({ kind: 'unhandled', error: { name: 'free text with spaces' } })
    expect(sent[0]).toMatchObject({ event: 'ui.error', kind: 'unhandled' })
    expect(sent[0]).not.toHaveProperty('errorName')
  })

  it('maps successful dashboard writes to actions by template', () => {
    const { sent } = capture()
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/runs', status: 201 })
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/ga/connect', status: 200 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}/runs', status: 200 })
    expect(actions(sent)).toEqual([['sweep.launch', undefined], ['integration.connect', 'ga']])
  })

  it('counts an OAuth start as connect_started, and the connection only when a property or account is chosen', () => {
    const { sent } = capture()
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/google/connect', status: 200 })
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/google-ads/oauth/connect', status: 200 })
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/gtm/oauth/connect', status: 200 })
    recordUiApiResult({ method: 'PUT', route: '/api/v1/projects/{name}/google/connections/{type}/property', path: '/api/v1/projects/acme-co/google/connections/gsc/property', status: 200 })
    recordUiApiResult({ method: 'PUT', route: '/api/v1/projects/{name}/google/connections/{type}/property', path: '/api/v1/projects/acme-co/google/connections/ga4/property', status: 200 })
    recordUiApiResult({ method: 'PUT', route: '/api/v1/projects/{name}/google-ads/selection', status: 200 })
    recordUiApiResult({ method: 'PUT', route: '/api/v1/projects/{name}/gtm/selection', status: 200 })
    recordUiApiResult({ method: 'DELETE', route: '/api/v1/projects/{name}/google/connections/{type}', path: '/api/v1/projects/acme-co/google/connections/gbp', status: 200 })
    expect(actions(sent)).toEqual([
      ['integration.connect_started', 'google'],
      ['integration.connect_started', 'google_ads'],
      ['integration.connect_started', 'gtm'],
      ['integration.connect', 'gsc'],
      ['integration.connect', 'ga'],
      ['integration.connect', 'google_ads'],
      ['integration.connect', 'gtm'],
      ['integration.disconnect', 'gbp'],
    ])
    expect(JSON.stringify(sent)).not.toContain('acme-co')
    for (const event of sent) expect(uiTelemetryEventSchema.safeParse(event).success).toBe(true)
  })

  it('tells a project create (201) from an update (200) on the upsert', () => {
    const { sent } = capture()
    recordUiApiResult({ method: 'PUT', route: '/api/v1/projects/{name}', status: 201 })
    recordUiApiResult({ method: 'PUT', route: '/api/v1/projects/{name}', status: 200 })
    expect(actions(sent)).toEqual([['project.create', undefined], ['project.update', undefined]])
  })

  it('reports unexpected 4xx, every 5xx and network failures, but not expected statuses', () => {
    const { sent } = capture()
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}/schedule', status: 404 })
    recordUiApiResult({ method: 'PUT', route: '/api/v1/projects/{name}/measurement-plan/draft/actions/upsert-target', status: 412 })
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/measurement-plan/draft/actions/publish', status: 409 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}/measurement-plan', status: 404 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}/technical-aeo/runs/{runId}/progress', status: 404 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}/backlinks/domains', status: 404 })
    recordUiApiResult({ method: 'POST', route: '/api/v1/projects', status: 409 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}', status: 401 })
    recordUiApiResult({ method: 'POST', route: '/api/v1/telemetry/ui', status: 500 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/acme-co/runs', status: 500 })
    expect(errors(sent)).toEqual([])

    recordUiApiResult({ method: 'POST', route: '/api/v1/projects/{name}/queries/generate', status: 429 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}/schedule', status: 500 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/projects/{name}', status: 404 })
    recordUiApiResult({ method: 'GET', route: '/api/v1/settings', network: true })
    expect(errors(sent)).toEqual([
      ['/api/v1/projects/{name}/queries/generate', 429],
      ['/api/v1/projects/{name}/schedule', 500],
      ['/api/v1/projects/{name}', 404],
      ['/api/v1/settings', 'network'],
    ])
    for (const event of sent) expect(uiTelemetryEventSchema.safeParse(event).success).toBe(true)
  })

  it('holds load metrics until the landing page is known, then attributes them to it', () => {
    const { sent } = capture()
    recordUiVital('TTFB', 'good')
    recordUiVital('FCP', 'needs-improvement')
    expect(sent).toEqual([])

    setUiPageFromRoute('/projects/$projectName/report')
    setUiPageFromRoute('/settings')
    recordUiVital('LCP', 'poor')
    const vitals = sent.filter(e => e.event === 'ui.vitals')
    expect(vitals.map(e => [e.metric, e.page])).toEqual([
      ['TTFB', '/projects/:projectName/report'],
      ['FCP', '/projects/:projectName/report'],
      ['LCP', '/projects/:projectName/report'],
    ])
    expect(vitals.every(e => e.page !== 'other')).toBe(true)
  })

  it('stops sending for the session once the server says it does not collect', async () => {
    const { sent } = capture({ accepted: false })
    trackUiAction('aero.open')
    await flush()
    trackUiAction('aero.send')
    expect(actions(sent)).toEqual([['aero.open', undefined]])
  })

  it('never throws into the UI when the sender fails', async () => {
    configureUiTelemetry({ send: async () => { throw new Error('offline') } })
    expect(() => trackUiAction('sweep.launch')).not.toThrow()
    await flush()
  })
})

describe('web vitals math', () => {
  it('CLS is the largest session window, not the page total, and ignores shifts after input', () => {
    const cls = createClsAccumulator()
    // Window 1: 0.05 + 0.05 (gap 500ms) = 0.10
    cls.add({ startTime: 0, value: 0.05, hadRecentInput: false })
    cls.add({ startTime: 500, value: 0.05, hadRecentInput: false })
    // Gap over 1s starts window 2: 0.08 + 0.04 = 0.12
    cls.add({ startTime: 2_000, value: 0.08, hadRecentInput: false })
    cls.add({ startTime: 2_600, value: 0.04, hadRecentInput: false })
    cls.add({ startTime: 2_700, value: 0.5, hadRecentInput: true })
    expect(cls.value()).toBeCloseTo(0.12)
  })

  it('CLS closes a window at 5s even when shifts keep coming', () => {
    const cls = createClsAccumulator()
    for (let t = 0; t <= 6_000; t += 500) cls.add({ startTime: t, value: 0.01, hadRecentInput: false })
    // 0..4500 is ten shifts in the first window; 5000..6000 starts a new one.
    expect(cls.value()).toBeCloseTo(0.1)
  })

  it('INP counts only real interactions', () => {
    const inp = createInpAccumulator()
    inp.add({ duration: 900 })
    inp.add({ duration: 900, interactionId: 0 })
    inp.add({ duration: 240, interactionId: 7 })
    expect(inp.value()).toBe(240)
    expect(rateVital('INP', inp.value())).toBe('needs-improvement')
  })
})

describe('delivery', () => {
  it('sends with keepalive so events flushed on pagehide still arrive', async () => {
    const requests: Request[] = []
    vi.stubGlobal('fetch', async (input: Request) => {
      requests.push(input)
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } })
    })
    await sendUiTelemetryEvent({
      event: 'ui.page_viewed',
      eventId: '30ed4717-c740-433f-9d37-05421e3f1a75',
      uiSessionId: '02db91c9-98d6-4826-b2cf-a9d4bec84768',
      page: '/',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.keepalive).toBe(true)
    expect(new URL(requests[0]!.url).pathname).toMatch(/\/api\/v1\/telemetry\/ui$/)
  })
})
