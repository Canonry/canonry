/**
 * Report line charts expose named keyboard navigation and live tooltip values.
 * Static bar charts and the coverage bar have no tooltip to reach, so their
 * image wrappers must not contain dead focus stops.
 *
 * This file deliberately does NOT stub recharts — the roles under test are
 * recharts' own output, so the shared stub would assert nothing. jsdom has no
 * layout, so ResponsiveContainer needs a ResizeObserver that reports a size.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { fullReport } from '../../../packages/contracts/test/fixtures/report-dto.js'
import { formatObservedInstantLabel, observedInstant } from '../src/components/shared/ChartPrimitives.js'
import { cleanupReportPage, renderReportPage } from './report-page-harness.js'

// A check's date is a real instant, labelled in the viewer's timezone.
const [firstCheck, secondCheck] = fullReport().citationsTrend.map(point => formatObservedInstantLabel(observedInstant(point.date)))

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

test('static agency charts do not add focus stops', () => {
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

test.each([
  ['Clicks over time', 'Apr 1, 2026', '0', 'Apr 2, 2026', '200'],
  ['AI referral sessions over time', 'Apr 15, 2026', '100', 'Apr 16, 2026', '100'],
  ['Verified crawler hits over time (last 7 days)', 'Apr 29, 2026', '30', 'Apr 30, 2026', '45'],
  // Citation rates are 0..100 on the wire and read through the shared percent rule.
  ['Overall citation rate', firstCheck!, '50.0%', secondCheck!, '55.0%'],
])('%s exposes dated values through keyboard navigation', async (title, firstDate, firstValue, secondDate, secondValue) => {
  const report = fullReport()
  report.gsc!.trend[0]!.clicks = 0
  renderReportPage(report, { audience: 'agency' })
  const chart = screen.getByRole('application', { name: `${title} line chart` })
  expect(chart.getAttribute('tabindex')).toBe('0')
  expect(chart.closest('[role="img"]')).toBeNull()

  const expectTooltip = async (date: string, value: string) => {
    await waitFor(() => {
      const tooltip = screen.getByRole('status')
      expect(tooltip.getAttribute('aria-live')).toBe('assertive')
      expect(within(tooltip).getByText(date)).toBeTruthy()
      expect(within(tooltip).getByText(value)).toBeTruthy()
    })
  }
  fireEvent.focus(chart)
  await expectTooltip(firstDate, firstValue)
  fireEvent.keyDown(chart, { key: 'ArrowRight' })
  await expectTooltip(secondDate, secondValue)
  fireEvent.keyDown(chart, { key: 'ArrowLeft' })
  await expectTooltip(firstDate, firstValue)
})
