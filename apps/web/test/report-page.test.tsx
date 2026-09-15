import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import {
  formatDate,
  REPORT_SECTION_COPY,
  ReportSectionIds,
  reportSectionOrder,
  type ProjectReportDto,
} from '@ainyc/canonry-contracts'
import { advancedReport, emptyReport, fullReport, richReport, simpleVisibility } from '../../../packages/contracts/test/fixtures/report-dto.js'
import { downloadReportHtml } from '../src/api.js'
import { cleanupReportPage, getReportSection, queryReportSection, renderReportPage, selectReportAudience } from './report-page-harness.js'
import {
  readReportOutline,
  readReportSectionIds,
  reportOutlineGolden,
  reportOutlineSection,
  type ReportOutlineFixture,
  type ReportOutlineSection,
} from './report-outline.js'

vi.mock('recharts', () => import('./report-recharts-stub.js'))
vi.mock('../src/api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/api.js')>(),
  downloadReportHtml: vi.fn(async () => undefined),
}))

afterEach(() => {
  cleanupReportPage()
  vi.mocked(downloadReportHtml).mockClear()
})

const OUTLINE_FIXTURES: Array<[ReportOutlineFixture, () => ProjectReportDto]> = [
  ['empty', emptyReport],
  ['full', fullReport],
  ['advanced', advancedReport],
]

describe('report audience', () => {
  test('the page opens on the client audience', () => {
    renderReportPage(fullReport())
    const toggle = screen.getByRole('group', { name: 'Report audience' })
    expect(within(toggle).getByRole('button', { name: 'Client' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(toggle).getByRole('button', { name: 'Agency' }).getAttribute('aria-pressed')).toBe('false')
  })

  test('agency is one click away, and client is one click back', () => {
    const report = fullReport()
    renderReportPage(report)
    selectReportAudience('agency')
    expect(screen.getByRole('button', { name: 'Agency' }).getAttribute('aria-pressed')).toBe('true')
    expect(readReportSectionIds(document.body)).toEqual(reportSectionOrder(report, 'agency'))
    selectReportAudience('client')
    expect(readReportSectionIds(document.body)).toEqual(reportSectionOrder(report, 'client'))
  })

  test('the download follows the selected audience and period', async () => {
    renderReportPage(richReport())
    selectReportAudience('agency')
    fireEvent.click(screen.getByRole('button', { name: 'Download report HTML' }))
    await vi.waitFor(() => expect(downloadReportHtml).toHaveBeenCalledWith('rich', 'agency', 30))
  })

  test('a read-only embed hides the toggle, shows the client report, and downloads the client report', async () => {
    const report = fullReport()
    renderReportPage(report, { embed: true })
    expect(screen.queryByRole('group', { name: 'Report audience' })).toBeNull()
    expect(readReportSectionIds(document.body)).toEqual(reportSectionOrder(report, 'client'))
    expect(queryReportSection(ReportSectionIds['executive-summary'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download report HTML' }))
    await vi.waitFor(() => expect(downloadReportHtml).toHaveBeenCalledWith('rich', 'client', 30))
  })
})

describe('section order', () => {
  test.each(OUTLINE_FIXTURES)('client sections of the %s report follow reportSectionOrder', (_name, build) => {
    const report = build()
    renderReportPage(report)
    expect(readReportSectionIds(document.body)).toEqual(reportSectionOrder(report, 'client'))
  })

  test.each(OUTLINE_FIXTURES)('agency sections of the %s report follow reportSectionOrder', (_name, build) => {
    const report = build()
    renderReportPage(report, { audience: 'agency' })
    expect(readReportSectionIds(document.body)).toEqual(reportSectionOrder(report, 'agency'))
  })

  test('the client view hides server activity until a source is connected; the agency view keeps the slot', () => {
    const report = richReport()
    report.serverActivity = null
    renderReportPage(report)
    expect(queryReportSection(ReportSectionIds['server-activity'])).toBeNull()
    selectReportAudience('agency')
    expect(queryReportSection(ReportSectionIds['server-activity'])).not.toBeNull()
  })
})

describe('parity with the HTML report outline', () => {
  test.each(OUTLINE_FIXTURES)('the client view of the %s report matches the HTML outline', (name, build) => {
    renderReportPage(build())
    expect(readReportOutline(document.body)).toEqual(reportOutlineGolden('client', name))
  })

  test.each(OUTLINE_FIXTURES)('every agency section of the %s report carries the HTML eyebrow and title', (name, build) => {
    renderReportPage(build(), { audience: 'agency' })
    const heading = ({ id, eyebrow, title }: ReportOutlineSection) => ({ id, eyebrow, title })
    expect(readReportOutline(document.body).sections.map(heading)).toEqual(reportOutlineGolden('agency', name).sections.map(heading))
  })

  test.each([['empty', emptyReport], ['full', fullReport]] as const)("the agency what's changed and action plan of the %s report match the HTML outline", (name, build) => {
    renderReportPage(build(), { audience: 'agency' })
    const outline = readReportOutline(document.body)
    const golden = reportOutlineGolden('agency', name)
    for (const id of [ReportSectionIds['whats-changed'], ReportSectionIds['agency-action-plan']]) {
      expect(reportOutlineSection(outline, id), id).toEqual(reportOutlineSection(golden, id))
    }
  })
})

describe('shared report shell', () => {
  test("the header names the market in the HTML report's words and dates the report the same way", () => {
    const report = richReport()
    renderReportPage(report)
    expect(document.querySelector('.page-header .page-subtitle')?.textContent)
      .toBe(`rich.example.com · US / EN · Market: michigan (Detroit, Michigan, US) · Last 7 days · Generated ${formatDate(report.meta.generatedAt)}`)
    cleanupReportPage()
    renderReportPage(emptyReport())
    expect(document.querySelector('.page-header .page-subtitle')?.textContent)
      .toBe(`demo.example.com · US / EN · No market set · Last 30 days · Generated ${formatDate(emptyReport().meta.generatedAt)}`)
  })

  test.each(['client', 'agency'] as const)('a repeated win shows a × 2 badge in its title cell for the %s audience', (audience) => {
    renderReportPage(fullReport(), { audience })
    const chip = within(getReportSection(ReportSectionIds['whats-changed'])).getByText('× 2')
    expect(chip.closest('td')?.textContent).toContain('Gained citation on answer engine')
  })

  test('the agency action plan without actions uses the HTML empty state', () => {
    renderReportPage(emptyReport(), { audience: 'agency' })
    expect(within(getReportSection(ReportSectionIds['agency-action-plan'])).getByText('No prioritized actions yet.')).toBeTruthy()
  })

  test('action ranks explain the ranking in each audience’s words', () => {
    renderReportPage(richReport())
    expect(within(getReportSection(ReportSectionIds['client-action-plan'])).getAllByTitle('Priority — 1 will move the needle fastest').map(rank => rank.textContent)).toEqual(['1'])
    selectReportAudience('agency')
    expect(within(getReportSection(ReportSectionIds['agency-action-plan'])).getAllByTitle('Impact rank — 1 is the highest-leverage action').map(rank => rank.textContent)).toEqual(['1', '2'])
  })

  test('a connected source with no data yet shows the empty state under the no-data heading', () => {
    const report = richReport()
    report.serverActivity = { ...report.serverActivity!, hasData: false }
    renderReportPage(report)
    const copy = REPORT_SECTION_COPY['server-activity']
    expect(reportOutlineSection(readReportOutline(document.body), ReportSectionIds['server-activity'])).toEqual({
      id: 'server-activity',
      eyebrow: copy.client.eyebrow,
      title: copy.title,
      intro: copy.client.introNoData,
      items: [{ empty: copy.client.empty }],
    })
  })

  test('visibility history rates are emphasized like the summary rates, as in the HTML report', () => {
    renderReportPage({ ...richReport(), visibility: simpleVisibility() })
    const rates = within(getReportSection(ReportSectionIds['client-summary'])).getAllByText('50%')
    expect(rates.map(rate => rate.tagName)).toEqual(['STRONG', 'STRONG', 'STRONG', 'STRONG'])
  })

  // A browser logs an invalid-nesting error for a block element inside a
  // paragraph, and parsing the same markup as HTML would move the element out.
  test.each(['client', 'agency'] as const)('the %s report never nests a block element inside a paragraph', (audience) => {
    renderReportPage(fullReport(), { audience })
    const nested = Array.from(document.querySelectorAll('p div, p p, p ul, p ol, p li, p table, p section, p article, p h2, p h3'))
      .map(element => `${element.closest('[data-report-section]')?.getAttribute('data-report-section') ?? 'header'}: <${element.tagName.toLowerCase()}> in <p>`)
    expect(nested).toEqual([])
  })
})
