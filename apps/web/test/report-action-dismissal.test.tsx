/**
 * An optimistic "Mark addressed" dismissal must outlive an audience switch.
 *
 * The client and agency action plans are separate sections with separate ids,
 * so toggling audience unmounts one and mounts the other. Dismissal state owned
 * by a plan section therefore dies with it, and a dismissal still waiting on its
 * POST reappears — in BOTH views — as if the click had failed.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fireEvent, within } from '@testing-library/react'
import { ReportSectionIds, type ProjectReportDto } from '@ainyc/canonry-contracts'
import { fullReport } from '../../../packages/contracts/test/fixtures/report-dto.js'
import { cleanupReportPage, getReportSection, renderReportPage, selectReportAudience } from './report-page-harness.js'

const dismissal = vi.hoisted(() => ({ mutate: vi.fn() }))

vi.mock('recharts', () => import('./report-recharts-stub.js'))
// A mutation that never settles: the dismissal stays in flight for the whole
// test, which is exactly the window in which a reader can switch audience.
vi.mock('../src/queries/mutations.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/queries/mutations.js')>(),
  useDismissContentTarget: () => dismissal,
}))

beforeEach(() => dismissal.mutate.mockClear())
afterEach(cleanupReportPage)

/** fullReport()'s top action, which both plans show, made dismissable. */
function reportWithDismissableAction(): ProjectReportDto {
  const report = fullReport()
  // `clientSummary.actionItems[0]` and `agencyDiagnostics.priorities[0]` are
  // the same object, so one targetRef makes the card dismissable in both plans.
  report.clientSummary.actionItems[0]!.targetRef = 'rich:create:best-aeo-platform'
  return report
}

const planFor = (audience: 'client' | 'agency') =>
  getReportSection(audience === 'client' ? ReportSectionIds['client-action-plan'] : ReportSectionIds['agency-action-plan'])

test('a dismissal still in flight stays dismissed across an audience switch, in both views', () => {
  const report = reportWithDismissableAction()
  const title = report.clientSummary.actionItems[0]!.title
  renderReportPage(report, { audience: 'agency' })

  expect(within(planFor('agency')).getByText(title)).toBeTruthy()
  fireEvent.click(within(planFor('agency')).getByRole('button', { name: 'Mark addressed' }))
  expect(dismissal.mutate).toHaveBeenCalledTimes(1)
  expect(within(planFor('agency')).queryByText(title)).toBeNull()

  selectReportAudience('client')
  expect(within(planFor('client')).queryByText(title)).toBeNull()

  selectReportAudience('agency')
  expect(within(planFor('agency')).queryByText(title)).toBeNull()
  // Still one call: a reappearing card invites a second click on work already
  // sent, which is how a duplicate dismissal would reach the server.
  expect(dismissal.mutate).toHaveBeenCalledTimes(1)
})

test('the client plan dismisses the same action and keeps it hidden in the agency view', () => {
  const report = reportWithDismissableAction()
  const title = report.clientSummary.actionItems[0]!.title
  renderReportPage(report)

  fireEvent.click(within(planFor('client')).getByRole('button', { name: 'Mark addressed' }))
  expect(within(planFor('client')).queryByText(title)).toBeNull()

  selectReportAudience('agency')
  expect(within(planFor('agency')).queryByText(title)).toBeNull()
})
