/**
 * Report charts must not add focus stops.
 *
 * Every report chart is wrapped in a presentational `<div role="img">` carrying
 * the chart's name. Recharts defaults `accessibilityLayer` ON, which turns its
 * `<svg>` into a focusable `role="application"`: an unnamed interactive element
 * nested inside a presentational one, and a dead tab stop on the bar charts and
 * the coverage bar, which have no tooltip to reach.
 *
 * This file deliberately does NOT stub recharts — the roles under test are
 * recharts' own output, so the shared stub would assert nothing. jsdom has no
 * layout, so ResponsiveContainer needs a ResizeObserver that reports a size.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fullReport } from '../../../packages/contracts/test/fixtures/report-dto.js'
import { cleanupReportPage, renderReportPage } from './report-page-harness.js'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback(
        [{ contentRect: { width: 640, height: 240 } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
    }

    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanupReportPage()
  vi.unstubAllGlobals()
})

test('the agency report draws every chart without adding a focus stop', () => {
  renderReportPage(fullReport(), { audience: 'agency' })

  // Guard the guard: charts that never rendered would satisfy the assertion
  // below while proving nothing about recharts' output.
  expect(document.querySelectorAll('[role="img"]').length).toBeGreaterThan(0)
  expect(document.querySelectorAll('.recharts-surface').length).toBeGreaterThan(0)

  const focusable = Array.from(
    document.querySelectorAll('[role="img"] [tabindex="0"], [role="img"] [role="application"]'),
    element => `${element.tagName.toLowerCase()}[role=${element.getAttribute('role')},tabindex=${element.getAttribute('tabindex')}]`,
  )
  expect(focusable).toEqual([])
})
