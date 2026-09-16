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

  // A heading two levels below the one before it leaves a gap in the document
  // outline: a screen reader's heading list shows a level-3 heading under the
  // level-1 title with no section heading between them, and heading-level
  // navigation skips straight past the section.
  test.each(['client', 'agency'] as const)('the %s report never skips a heading level', (audience) => {
    renderReportPage(fullReport(), { audience })
    const levels = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'), heading => Number(heading.tagName.slice(1)))
    const skips = levels.flatMap((level, index) => index > 0 && level > levels[index - 1]! + 1 ? [`h${levels[index - 1]} → h${level}`] : [])
    expect(skips).toEqual([])
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

/**
 * The client server-activity summary. The HTML report tones each prior-window
 * delta (`<span class="tone-positive">`) and the agency view tones the same
 * copy, so a client reading the in-app report must see the same colour as the
 * client reading the downloaded one. Tile subtitles are not part of the outline,
 * so nothing else holds these lines to the HTML.
 */
describe('client server activity', () => {
  const copy = REPORT_SECTION_COPY['server-activity']

  /** The line under a tile's value, found by the tile's label. */
  function tileSubtitle(section: HTMLElement, label: string): HTMLElement {
    const labelElement = Array.from(section.querySelectorAll<HTMLElement>('[data-report-tile]'))
      .find(element => element.textContent === label)
    const subtitle = labelElement?.parentElement?.children[2]
    if (!(subtitle instanceof HTMLElement)) throw new Error(`Tile "${label}" has no line under its value`)
    return subtitle
  }

  test('a rising delta carries the positive tone, beside the untoned crawler trust summary', () => {
    renderReportPage(richReport())
    const section = getReportSection(ReportSectionIds['server-activity'])
    const crawler = tileSubtitle(section, copy.client.tiles.botRequests)
    expect(crawler.textContent).toBe('234 verified · 15 unverified · Up 104% vs prior 7 days (122 requests)')
    expect(within(crawler).getByText('Up 104% vs prior 7 days (122 requests)').className).toContain('text-positive-400')
    // Only the delta is toned; the crawler trust summary rides beside it plain.
    expect(crawler.querySelectorAll('[class*="text-positive"], [class*="text-caution"], [class*="text-negative"]')).toHaveLength(1)

    // The referral line joins the delta, the paid/organic split and the
    // redirect note in the HTML report's order; only the delta is toned.
    const referral = tileSubtitle(section, copy.client.tiles.referralSessions)
    expect(referral.textContent).toBe('Up 100% vs prior 7 days (6 sessions) · Paid 9 · Organic 2 · Unclassified 1')
    expect(within(referral).getByText('Up 100% vs prior 7 days (6 sessions)').className).toContain('text-positive-400')
    expect(within(referral).getByText(/Paid 9 · Organic 2 · Unclassified 1/).className).not.toMatch(/text-(positive|caution|negative)/)
  })

  test('a falling delta reads negative, a flat one stays untoned, and a delta with no copy falls back', () => {
    const report = richReport()
    report.serverActivity = {
      ...report.serverActivity!,
      verifiedCrawlerHits: { current: 100, prior: 200, deltaPct: -50 },
      unverifiedCrawlerHits: { current: 0, prior: 0, deltaPct: null },
      aiUserFetchHits: { current: 42, prior: 42, deltaPct: 0 },
    }
    renderReportPage(report)
    const section = getReportSection(ReportSectionIds['server-activity'])

    const crawler = tileSubtitle(section, copy.client.tiles.botRequests)
    expect(crawler.textContent).toBe('100 verified · 0 unverified · Down 50% vs prior 7 days (200 requests)')
    expect(within(crawler).getByText('Down 50% vs prior 7 days (200 requests)').className).toContain('text-negative-400')

    const fetches = tileSubtitle(section, copy.client.tiles.userFetches)
    expect(fetches.textContent).toBe('Flat vs prior 7 days (42 requests)')
    expect(within(fetches).getByText('Flat vs prior 7 days (42 requests)').className).not.toMatch(/text-(positive|caution|negative)/)
  })

  test('a first baseline says so, and a delta with no copy at all falls back to the HTML line', () => {
    // A zero prior window is a first baseline and names itself as one.
    const baseline = richReport()
    baseline.serverActivity = { ...baseline.serverActivity!, aiUserFetchHits: { current: 42, prior: 0, deltaPct: null } }
    renderReportPage(baseline)
    expect(tileSubtitle(getReportSection(ReportSectionIds['server-activity']), copy.client.tiles.userFetches).textContent)
      .toBe('First baseline week')

    cleanupReportPage()
    // A prior window with no computable percentage produces no delta copy, so
    // the tile falls back to naming the fetchers it counts, as the HTML does.
    const noCopy = richReport()
    noCopy.serverActivity = { ...noCopy.serverActivity!, aiUserFetchHits: { current: 42, prior: 3, deltaPct: null } }
    renderReportPage(noCopy)
    expect(tileSubtitle(getReportSection(ReportSectionIds['server-activity']), copy.client.tiles.userFetches).textContent)
      .toBe(copy.client.userFetchFallback)
  })
})
