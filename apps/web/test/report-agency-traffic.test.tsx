/**
 * Agency report slice S3, search and traffic: GSC Performance, GA4 Traffic,
 * Social Referrals and AI Referral Traffic.
 *
 * The in-app agency report must show what the downloadable HTML report shows
 * for the same DTO (`renderGsc`, `renderGa`, `renderSocial` and
 * `renderAiReferrals` in packages/api-routes/src/report-renderer.ts). The
 * committed outline goldens pin each section's structure; the checks below pin
 * the values, their formats, the bar colors, and the blocks that come and go
 * with the data.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { within } from '@testing-library/react'
import {
  REPORT_SECTION_COPY,
  ReportSectionIds,
  type ProjectReportDto,
  type ReportSectionId,
} from '@ainyc/canonry-contracts'
import { advancedReport, emptyReport, fullReport, richReport } from '../../../packages/contracts/test/fixtures/report-dto.js'
import { REPORT_CHART_COLORS } from '../src/pages/ReportPage.js'
import { cleanupReportPage, getReportSection, queryReportSection, renderReportPage } from './report-page-harness.js'
import { pinReportGoldenTimeZone, readReportOutline, reportOutlineGolden, reportOutlineSection, type ReportOutlineFixture } from './report-outline.js'

vi.mock('recharts', () => import('./report-recharts-stub.js'))

pinReportGoldenTimeZone()
afterEach(cleanupReportPage)

const TRAFFIC_SECTION_IDS: readonly ReportSectionId[] = [
  ReportSectionIds.gsc,
  ReportSectionIds.ga,
  ReportSectionIds['social-referrals'],
  ReportSectionIds['ai-referrals'],
]

const OUTLINE_FIXTURES: Array<[ReportOutlineFixture, () => ProjectReportDto]> = [
  ['empty', emptyReport],
  ['full', fullReport],
  ['advanced', advancedReport],
]

function renderAgency(report: ProjectReportDto): void {
  renderReportPage(report, { audience: 'agency' })
}

function introText(section: HTMLElement): string | null {
  return section.querySelector('[data-report-intro]')?.textContent ?? null
}

/** Every metric tile in the section, as [label, value]. */
function readTiles(section: HTMLElement): Array<[string, string]> {
  return Array.from(section.querySelectorAll('[data-report-tile]'), label => [label.textContent ?? '', label.nextElementSibling?.textContent ?? ''])
}

/** Card, chart and table titles, in document order. */
function readHeadings(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll('[data-report-heading]'), heading => heading.textContent ?? '')
}

/** The card whose title reads `title`. */
function cardTitled(section: HTMLElement, title: string): HTMLElement {
  const heading = Array.from(section.querySelectorAll('[data-report-heading]')).find(element => element.textContent === title)
  const card = heading?.closest<HTMLElement>('.rounded-xl')
  if (!card) throw new Error(`No card titled "${title}"`)
  return card
}

/** The first table after the title `title`, in document order. */
function tableAfter(section: HTMLElement, title: string): HTMLTableElement {
  const nodes = Array.from(section.querySelectorAll('[data-report-heading], table'))
  const start = nodes.findIndex(node => node.hasAttribute('data-report-heading') && node.textContent === title)
  const table = start === -1 ? undefined : nodes.slice(start + 1).find((node): node is HTMLTableElement => node instanceof HTMLTableElement)
  if (!table) throw new Error(`No table after "${title}"`)
  return table
}

function headerCells(table: HTMLTableElement): string[] {
  return Array.from(table.querySelectorAll('thead th'), cell => cell.textContent ?? '')
}

function bodyRows(table: HTMLTableElement): string[][] {
  return Array.from(table.querySelectorAll('tbody tr'), row => Array.from(row.querySelectorAll('td'), cell => cell.textContent ?? ''))
}

/** Each bar of the share-bar card titled `title`: its label, the text after it, its width and its fill. */
function readShareBars(section: HTMLElement, title: string): Array<{ label: string; value: string; width: string; color: string }> {
  return Array.from(cardTitled(section, title).querySelectorAll<HTMLElement>('[data-share-bar]'), bar => {
    const row = bar.closest('.grid')
    return {
      label: row?.querySelector('p')?.textContent ?? '',
      value: row?.lastElementChild?.textContent ?? '',
      width: bar.style.width,
      color: bar.style.background,
    }
  })
}

describe('parity with the HTML report outline', () => {
  test.each(OUTLINE_FIXTURES)('the agency search and traffic sections of the %s report match the HTML outline', (name, build) => {
    renderAgency(build())
    const outline = readReportOutline(document.body)
    const golden = reportOutlineGolden('agency', name)
    for (const id of TRAFFIC_SECTION_IDS) {
      expect(reportOutlineSection(golden, id), `${id} is in the golden`).toBeDefined()
      expect(reportOutlineSection(outline, id), id).toEqual(reportOutlineSection(golden, id))
    }
  })

  test('the client audience renders none of these sections', () => {
    renderReportPage(fullReport())
    for (const id of TRAFFIC_SECTION_IDS) expect(queryReportSection(id), id).toBeNull()
  })

  test.each([
    [ReportSectionIds.gsc, 'Connect Google Search Console to populate this section.'],
    [ReportSectionIds.ga, 'Connect Google Analytics 4 to populate this section.'],
    [ReportSectionIds['social-referrals'], 'No social referral data yet.'],
    [ReportSectionIds['ai-referrals'], 'No AI referral traffic detected yet.'],
  ] as const)('without data, %s shows only the HTML empty state and no intro', (id, message) => {
    renderAgency(emptyReport())
    const copy = REPORT_SECTION_COPY[id]
    expect(reportOutlineSection(readReportOutline(document.body), id)).toEqual({
      id,
      eyebrow: copy.eyebrow,
      title: copy.title,
      intro: null,
      items: [{ empty: message }],
      content: [{ text: message }],
    })
  })
})

describe('GSC Performance', () => {
  test('the intro names the reporting window in the HTML report’s words', () => {
    renderAgency(fullReport())
    expect(introText(getReportSection(ReportSectionIds.gsc)))
      .toBe('Search demand signals to compare against AI visibility for Apr 1, 2026 → Apr 30, 2026.')
  })

  test('without a summary window the intro reads the section window, as the HTML report does', () => {
    const report = fullReport()
    report.executiveSummary.gsc = null
    report.gsc!.periodStart = '2026-03-01'
    renderAgency(report)
    expect(introText(getReportSection(ReportSectionIds.gsc)))
      .toBe('Search demand signals to compare against AI visibility for Mar 1, 2026 → Apr 30, 2026.')
  })

  test('the tiles format the totals the way the HTML report does', () => {
    renderAgency(fullReport())
    expect(readTiles(getReportSection(ReportSectionIds.gsc))).toEqual([
      ['Total clicks', '1.0K'],
      ['Total impressions', '5.0K'],
      ['Avg CTR', '20.0%'],
      ['Avg position', '4.5'],
    ])
  })

  test('clicks over time is a line chart named like the HTML chart, and is left out without trend data', () => {
    const report = fullReport()
    renderAgency(report)
    expect(within(getReportSection(ReportSectionIds.gsc)).getByRole('img', { name: 'Clicks over time line chart' })).toBeTruthy()

    cleanupReportPage()
    report.gsc!.trend = []
    renderAgency(report)
    const section = getReportSection(ReportSectionIds.gsc)
    expect(within(section).queryByRole('img', { name: 'Clicks over time line chart' })).toBeNull()
    expect(readHeadings(section)).not.toContain('Clicks over time')
  })

  test('top queries lists every query with the HTML columns and cell formats', () => {
    renderAgency(fullReport())
    const table = tableAfter(getReportSection(ReportSectionIds.gsc), 'Top queries')
    expect(headerCells(table)).toEqual(['Query', 'Clicks', 'Imp.', 'CTR', 'Pos.', 'Category'])
    expect(Array.from(table.querySelectorAll('thead th'), cell => cell.classList.contains('text-right')))
      .toEqual([false, true, true, true, true, false])
    expect(bodyRows(table)).toEqual([
      ['rich brand', '800', '3.0K', '27.0%', '1.5', 'brand'],
      ['best aeo', '200', '2.0K', '10.0%', '5.5', 'industry'],
    ])
  })

  test('search demand by intent draws each category at its share of clicks, in series color order', () => {
    renderAgency(fullReport())
    expect(readShareBars(getReportSection(ReportSectionIds.gsc), 'Search demand by intent')).toEqual([
      { label: 'brand', value: '800 clicks · 80%', width: '80%', color: REPORT_CHART_COLORS.series[0] },
      { label: 'industry', value: '200 clicks · 20%', width: '20%', color: REPORT_CHART_COLORS.series[1] },
    ])
  })

  test('a category with no clicks and no share is left out without shifting colors, and the card goes when none is left', () => {
    const report = fullReport()
    const gsc = report.gsc!
    gsc.categoryBreakdown = gsc.categoryBreakdown.map((row, index) => index === 0 ? { ...row, clicks: 0, sharePct: 0 } : row)
    renderAgency(report)
    expect(readShareBars(getReportSection(ReportSectionIds.gsc), 'Search demand by intent')).toEqual([
      { label: 'industry', value: '200 clicks · 20%', width: '20%', color: REPORT_CHART_COLORS.series[1] },
    ])

    cleanupReportPage()
    gsc.categoryBreakdown = gsc.categoryBreakdown.map(row => ({ ...row, clicks: 0, sharePct: 0 }))
    renderAgency(report)
    expect(readHeadings(getReportSection(ReportSectionIds.gsc))).not.toContain('Search demand by intent')
  })

  test('the crossover chip cards show with the full report and are absent with the rich report', () => {
    renderAgency(fullReport())
    const section = getReportSection(ReportSectionIds.gsc)
    const untracked = cardTitled(section, 'AEO queries without search demand')
    expect(within(untracked).getByText('Review whether these still belong in the tracking set.')).toBeTruthy()
    expect(within(untracked).getByText('answer engine')).toBeTruthy()
    const suggested = cardTitled(section, 'Search queries you should track')
    expect(within(suggested).getByText('High-impression candidates to add to AEO tracking.')).toBeTruthy()
    expect(within(suggested).getByText('aeo software pricing')).toBeTruthy()

    cleanupReportPage()
    renderAgency(richReport())
    expect(readHeadings(getReportSection(ReportSectionIds.gsc))).toEqual(['Clicks over time', 'Top queries', 'Search demand by intent'])
  })

  test('a chip card shows at most six queries, then counts the rest', () => {
    const report = fullReport()
    report.gsc!.trackedButNoGsc = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']
    renderAgency(report)
    const card = cardTitled(getReportSection(ReportSectionIds.gsc), 'AEO queries without search demand')
    expect(within(card).getByText('q6')).toBeTruthy()
    expect(within(card).queryByText('q7')).toBeNull()
    expect(within(card).getByText('+2 more')).toBeTruthy()
  })
})

describe('GA4 Traffic', () => {
  test('the intro names the GA window and the tiles format the totals', () => {
    renderAgency(fullReport())
    const section = getReportSection(ReportSectionIds.ga)
    expect(introText(section)).toBe('Site traffic from Apr 1, 2026 to Apr 30, 2026.')
    expect(readTiles(section)).toEqual([
      ['Total sessions', '12.0K'],
      ['Total users', '9.0K'],
      ['Organic sessions', '8.0K'],
    ])
  })

  test('top landing pages split a tracked URL into its path and a tracking summary titled with the full URL', () => {
    renderAgency(fullReport())
    const table = tableAfter(getReportSection(ReportSectionIds.ga), 'Top landing pages')
    expect(headerCells(table)).toEqual(['Page', 'Sessions', 'Organic'])
    const rows = Array.from(table.querySelectorAll<HTMLElement>('tbody tr'))
    expect(rows).toHaveLength(2)
    expect(Array.from(rows[0]!.querySelectorAll('td'), cell => cell.textContent)).toEqual(['/', '6.0K', '4.0K'])
    const pricing = rows[1]!
    expect(within(pricing).getByText('/pricing')).toBeTruthy()
    expect(within(pricing).getByText('Google Ad · 2 params').getAttribute('title')).toBe('/pricing?gclid=abc&utm_source=x')
    expect(Array.from(pricing.querySelectorAll('td'), cell => cell.textContent).slice(1)).toEqual(['900', '0'])
  })

  test('channel mix draws each channel at its share of sessions', () => {
    renderAgency(fullReport())
    expect(readShareBars(getReportSection(ReportSectionIds.ga), 'Channel mix')).toEqual([
      { label: 'Organic Search', value: '8.0K sessions · 67%', width: '67%', color: REPORT_CHART_COLORS.series[0] },
      { label: 'Direct', value: '4.0K sessions · 33%', width: '33%', color: REPORT_CHART_COLORS.series[1] },
    ])
  })
})

describe('Social Referrals', () => {
  test('the tiles, the channel mix and the campaigns read as the HTML report prints them', () => {
    renderAgency(fullReport())
    const section = getReportSection(ReportSectionIds['social-referrals'])
    expect(introText(section)).toBe('Social traffic split by channel and campaign.')
    expect(readTiles(section)).toEqual([
      ['Total sessions', '1.5K'],
      ['Organic social', '1.0K'],
      ['Paid social', '500'],
    ])
    expect(readShareBars(section, 'Social channel mix')).toEqual([
      { label: 'Organic Social', value: '1.0K sessions · 67%', width: '67%', color: REPORT_CHART_COLORS.series[0] },
      { label: 'Paid Social', value: '500 sessions · 33%', width: '33%', color: REPORT_CHART_COLORS.series[1] },
    ])
    expect(bodyRows(tableAfter(section, 'Top campaigns'))).toEqual([['linkedin.com', 'referral', '700']])
  })

  test('top campaigns keeps its headers when there are no campaigns', () => {
    const report = fullReport()
    report.socialReferrals!.topCampaigns = []
    renderAgency(report)
    const table = tableAfter(getReportSection(ReportSectionIds['social-referrals']), 'Top campaigns')
    expect(headerCells(table)).toEqual(['Source', 'Medium', 'Sessions'])
    expect(bodyRows(table)).toEqual([])
  })
})

describe('AI Referral Traffic', () => {
  test('the total, the sessions trend, and the sources colored from the third series color on', () => {
    renderAgency(fullReport())
    const section = getReportSection(ReportSectionIds['ai-referrals'])
    expect(introText(section)).toBe('Traffic arriving from AI answer engines.')
    expect(readTiles(section)).toEqual([['Total sessions', '200']])
    expect(within(section).getByRole('img', { name: 'AI referral sessions over time line chart' })).toBeTruthy()
    expect(readShareBars(section, 'AI sessions by source')).toEqual([
      { label: 'chatgpt.com', value: '150 sessions · 75%', width: '75%', color: REPORT_CHART_COLORS.series[2] },
      { label: 'gemini.google.com', value: '50 sessions · 25%', width: '25%', color: REPORT_CHART_COLORS.series[3] },
    ])
  })

  test('top AI landing pages always renders and reports sessions only, never users', () => {
    const report = fullReport()
    renderAgency(report)
    const section = getReportSection(ReportSectionIds['ai-referrals'])
    const table = tableAfter(section, 'Top AI landing pages')
    expect(headerCells(table)).toEqual(['Page', 'Sessions'])
    expect(bodyRows(table)).toEqual([['/', '120']])
    expect(section.textContent).not.toMatch(/users/i)

    cleanupReportPage()
    report.aiReferrals!.topLandingPages = []
    report.aiReferrals!.trend = []
    renderAgency(report)
    const bare = getReportSection(ReportSectionIds['ai-referrals'])
    expect(headerCells(tableAfter(bare, 'Top AI landing pages'))).toEqual(['Page', 'Sessions'])
    expect(bodyRows(tableAfter(bare, 'Top AI landing pages'))).toEqual([])
    expect(within(bare).queryByRole('img', { name: 'AI referral sessions over time line chart' })).toBeNull()
  })
})
