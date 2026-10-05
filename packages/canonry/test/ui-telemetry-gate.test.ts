import { describe, expect, it } from 'vitest'
import type { UiTelemetryEvent } from '@ainyc/canonry-contracts'
import { createUiTelemetryGate, UI_EVENT_HOUR_CAPACITY, UI_EVENT_MINUTE_CAPACITY } from '../src/ui-telemetry-gate.js'

const event = {
  event: 'ui.page_viewed',
  eventId: '30ed4717-c740-433f-9d37-05421e3f1a75',
  uiSessionId: '02db91c9-98d6-4826-b2cf-a9d4bec84768',
  page: '/',
} as UiTelemetryEvent

function gate(enabled = true) {
  let clock = 0
  const recorded: UiTelemetryEvent[] = []
  const accept = createUiTelemetryGate({ now: () => clock, enabled: () => enabled, record: e => { recorded.push(e) } })
  return { accept, recorded, advance: (ms: number) => { clock += ms } }
}

describe('UI telemetry gate', () => {
  it('declines and records nothing while telemetry is off', () => {
    const { accept, recorded } = gate(false)
    expect(accept(event)).toBe(false)
    expect(recorded).toEqual([])
  })

  it('allows a burst of 60, then refills one per second', () => {
    const { accept, recorded, advance } = gate()
    const results = Array.from({ length: UI_EVENT_MINUTE_CAPACITY + 5 }, () => accept(event))
    expect(results.filter(Boolean)).toHaveLength(UI_EVENT_MINUTE_CAPACITY)
    expect(accept(event)).toBe(false)
    advance(1_000)
    expect(accept(event)).toBe(true)
    expect(recorded).toHaveLength(UI_EVENT_MINUTE_CAPACITY + 1)
  })

  it('settles at 600 an hour once the burst is spent, even under the minute limit', () => {
    const { accept, advance } = gate()
    // Two events a second: the minute bucket alone would allow ~3,600 an hour.
    const runHour = () => {
      let accepted = 0
      for (let i = 0; i < 7_200; i += 1) {
        if (accept(event)) accepted += 1
        advance(500)
      }
      return accepted
    }
    runHour() // spends the initial burst of 600 plus that hour's refill
    const steady = runHour()
    expect(steady).toBeLessThanOrEqual(UI_EVENT_HOUR_CAPACITY + 1)
    expect(steady).toBeGreaterThanOrEqual(UI_EVENT_HOUR_CAPACITY - 1)
  })
})
