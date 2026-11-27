import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uiTelemetryEventSchema, type UiTelemetryEvent } from '@canonry/canonry-contracts'
import { installUiPageTime } from '../src/lib/ui-page-time.js'
import { configureUiTelemetry, resetUiTelemetryForTests, trackUiAction } from '../src/lib/ui-telemetry.js'

let timer: ReturnType<typeof installUiPageTime>
let events: UiTelemetryEvent[]
let visible: boolean
let focused: boolean
const checkpoints = () => events.filter(e => e.event === 'ui.page_time')

beforeEach(() => {
  vi.useFakeTimers()
  visible = focused = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden')
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  events = []
  timer = installUiPageTime()
  configureUiTelemetry({ send: async e => { events.push(e); return { accepted: true } } })
})
afterEach(() => {
  timer.stop()
  resetUiTelemetryForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('screen time', () => {
  it('attributes each visit to its screen, including same-template project changes and revisits', () => {
    timer.navigate('/projects/$projectName/agent-readiness', '/projects/private-one/agent-readiness')
    vi.advanceTimersByTime(20_000)
    // Filter changes on the same route do not start another visit.
    timer.navigate('/projects/$projectName/agent-readiness', '/projects/private-one/agent-readiness')
    vi.advanceTimersByTime(10_000)
    timer.navigate('/projects/$projectName/agent-readiness', '/projects/private-two/agent-readiness')
    vi.advanceTimersByTime(60_000)
    timer.navigate('/settings', '/settings')
    vi.advanceTimersByTime(5_000)
    timer.navigate('/projects/$projectName/agent-readiness', '/projects/private-one/agent-readiness')
    vi.advanceTimersByTime(5_000)
    window.dispatchEvent(new Event('pagehide'))
    const ends = checkpoints().filter(e => e.completed)
    expect(ends.map(e => [e.page, e.foregroundMs])).toEqual([
      ['/projects/:projectName/agent-readiness', 30_000],
      ['/projects/:projectName/agent-readiness', 60_000],
      ['/settings', 5_000],
      ['/projects/:projectName/agent-readiness', 5_000],
    ])
    expect(new Set(ends.map(e => e.visitId)).size).toBe(4)
    expect(JSON.stringify(events)).not.toContain('private-')
    for (const e of events) expect(uiTelemetryEventSchema.parse(e)).toEqual(e)
  })

  it('pauses on background tabs and unfocused windows without double-counting visibility events', () => {
    timer.navigate('/runs', '/runs')
    vi.advanceTimersByTime(20_000)
    focused = false
    window.dispatchEvent(new Event('blur'))
    vi.advanceTimersByTime(90_000)
    visible = false
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(90_000)
    visible = focused = true
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(10_000)
    window.dispatchEvent(new Event('pagehide'))
    expect(checkpoints().at(-1)).toMatchObject({ foregroundMs: 30_000, activeMs: 30_000, completed: true })
    expect(new Set(checkpoints().map(e => e.visitId)).size).toBe(1)
  })

  it('separates idle time from recent interaction while still counting foreground reading time', () => {
    timer.navigate('/settings', '/settings')
    vi.advanceTimersByTime(90_000)
    document.dispatchEvent(new Event('pointermove'))
    vi.advanceTimersByTime(10_000)
    window.dispatchEvent(new Event('pagehide'))
    expect(checkpoints().at(-1)).toMatchObject({ foregroundMs: 100_000, activeMs: 70_000 })
  })

  it('does not bill an unobserved browser suspension as time spent', () => {
    timer.navigate('/runs', '/runs')
    vi.advanceTimersByTime(10_000)
    vi.spyOn(performance, 'now').mockReturnValue(600_000)
    vi.setSystemTime(Date.now() + 590_000)
    window.dispatchEvent(new Event('pagehide'))
    expect(checkpoints().at(-1)).toMatchObject({ foregroundMs: 10_000, activeMs: 10_000 })
  })

  it('discards pending time after the server refuses telemetry', async () => {
    configureUiTelemetry({
      send: async e => { events.push(e); return { accepted: false } },
      onDisabled: () => timer.stop(),
    })
    timer.navigate('/runs', '/runs')
    vi.advanceTimersByTime(10_000)
    trackUiAction('aero.open')
    await Promise.resolve()
    vi.advanceTimersByTime(120_000)
    window.dispatchEvent(new Event('pagehide'))
    expect(checkpoints()).toEqual([])
    expect(events).toHaveLength(1)
  })

  it('clears the old screen on auth teardown and resumes with a new visit', () => {
    timer.navigate('/runs', '/runs')
    vi.advanceTimersByTime(5_000)
    timer.clear()
    vi.advanceTimersByTime(120_000)
    expect(events).toEqual([])
    timer.navigate('/runs', '/runs')
    vi.advanceTimersByTime(8_000)
    window.dispatchEvent(new Event('pagehide'))
    expect(checkpoints().at(-1)).toMatchObject({ foregroundMs: 8_000 })
  })

  it('finishes once on pagehide and starts a new visit after back-forward cache restoration', () => {
    timer.navigate('/runs', '/runs')
    vi.advanceTimersByTime(10_000)
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pagehide'))
    vi.advanceTimersByTime(100_000)
    window.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(20_000)
    window.dispatchEvent(new Event('pagehide'))
    expect(checkpoints().map(e => e.foregroundMs)).toEqual([10_000, 20_000])
    expect(new Set(checkpoints().map(e => e.visitId)).size).toBe(2)
  })

  it('recovers a rate-limited intermediate checkpoint in the next cumulative update', () => {
    timer.navigate('/runs', '/runs')
    vi.advanceTimersByTime(59_000)
    for (let i = 0; i < 30; i++) trackUiAction('aero.open')
    vi.advanceTimersByTime(1_000)
    expect(checkpoints()).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(checkpoints().at(-1)).toMatchObject({ foregroundMs: 120_000, activeMs: 60_000 })
  })
})
