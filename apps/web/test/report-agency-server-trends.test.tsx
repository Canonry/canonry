/**
 * Agency report slice S4: server-side activity, indexing health, and the
 * citations trend. The HTML report's committed outline goldens hold each
 * section's shape (headings, tiles, table headers, notes, empty states); the
 * tests below pin what an outline cannot see: the values, the tones, the
 * window labels, and every branch the HTML renderer takes.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { within } from '@testing-library/react'
import {
  formatDate,
  MIN_TREND_POINTS,
  REPORT_SECTION_COPY,
  reportCitationsTrendBaseline,
  ReportSectionIds,
  type ProjectReportDto,
} from '@ainyc/canonry-contracts'
import {
  advancedReport,
  emptyReport,
  fullReport,
  reportWithChangeHistory,
  richReport,
} from '../../../packages/contracts/test/fixtures/report-dto.js'
import { cleanupReportPage, getReportSection, queryReportSection, renderReportPage, selectReportAudience } from './report-page-harness.js'
import {
  pinReportGoldenTimeZone,
  readReportOutline,
  readReportSectionIds,
  reportOutlineGolden,
  reportOutlineSection,
  type ReportOutlineFixture,
} from './report-outline.js'

vi.mock('recharts', () => import('./report-recharts-stub.js'))
pinReportGoldenTimeZone()
afterEach(cleanupReportPage)

const SERVER_ACTIVITY = ReportSectionIds['server-activity']
const INDEXING_HEALTH = ReportSectionIds['indexing-health']
const CITATIONS_TREND = ReportSectionIds['citations-trend']

const OUTLINE_FIXTURES: Array<[ReportOutlineFixture, () => ProjectReportDto]> = [
  ['empty', emptyReport],
  ['full', fullReport],
  ['advanced', advancedReport],
]

/**
 * Any tone at all. `caution` belongs in the set even though no delta should
 * ever carry it: excluding it let a neutral delta render in amber — reading as
 * a warning the HTML report does not show — while every "untoned" assertion
 * below still passed.
 */
const TONED = /text-(positive|caution|negative)-400/

/** A metric tile's value and its optional line underneath, found by the tile's label. */
function tile(section: HTMLElement, label: string): { value: HTMLElement; subtitle: HTMLElement | undefined } {
  const labelElement = Array.from(section.querySelectorAll<HTMLElement>('[data-report-tile]')).find(element => element.textContent === label)
  if (!labelElement?.parentElement) throw new Error(`No tile labeled "${label}"`)
  const [, value, subtitle] = Array.from(labelElement.parentElement.children) as HTMLElement[]
  if (!value) throw new Error(`Tile "${label}" has no value`)
  return { value, subtitle }
}

function tileLabels(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll('[data-report-tile]'), element => element.textContent ?? '')
}

function headings(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll('[data-report-heading]'), element => element.textContent ?? '')
}

function tables(section: HTMLElement): HTMLTableElement[] {
  return Array.from(section.querySelectorAll('table'))
}

function headerCells(table: HTMLTableElement): string[] {
  return Array.from(table.querySelectorAll('thead th'), header => header.textContent ?? '')
}

function bodyRows(table: HTMLTableElement): string[][] {
  return Array.from(table.querySelectorAll('tbody tr'), row => Array.from(row.querySelectorAll('td'), cell => cell.textContent ?? ''))
}

/** The one body cell whose whole text is `text`. */
function bodyCell(table: HTMLTableElement, text: string): HTMLElement {
  const matches = Array.from(table.querySelectorAll<HTMLElement>('tbody td')).filter(cell => cell.textContent === text)
  if (matches.length !== 1) throw new Error(`Expected one cell reading "${text}", found ${matches.length}`)
  return matches[0]!
}

function sectionIntro(section: HTMLElement): string | null {
  return section.querySelector('[data-report-intro]')?.textContent ?? null
}

describe('parity with the HTML report outline', () => {
  test.each(OUTLINE_FIXTURES)('agency server activity, indexing health and citations trend of the %s report match the HTML outline', (name, build) => {
    renderReportPage(build(), { audience: 'agency' })
    const outline = readReportOutline(document.body)
    const golden = reportOutlineGolden('agency', name)
    for (const id of [SERVER_ACTIVITY, INDEXING_HEALTH, CITATIONS_TREND]) {
      expect(reportOutlineSection(outline, id), id).toEqual(reportOutlineSection(golden, id))
    }
  })

  test('the agency report places server activity right after AI referrals, then indexing health and the citations trend', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const ids = readReportSectionIds(document.body)
    const aiReferrals = ids.indexOf(ReportSectionIds['ai-referrals'])
    expect(aiReferrals).toBeGreaterThan(-1)
    expect(ids.slice(aiReferrals, aiReferrals + 4)).toEqual([ReportSectionIds['ai-referrals'], SERVER_ACTIVITY, INDEXING_HEALTH, CITATIONS_TREND])
  })

  test('the client report renders no indexing health or citations trend, and keeps its own server activity summary', () => {
    const copy = REPORT_SECTION_COPY['server-activity']
    renderReportPage(fullReport())
    expect(queryReportSection(INDEXING_HEALTH)).toBeNull()
    expect(queryReportSection(CITATIONS_TREND)).toBeNull()
    const clientView = getReportSection(SERVER_ACTIVITY)
    expect(clientView.querySelector('[data-report-eyebrow]')?.textContent).toBe(copy.client.eyebrow)
    expect(headings(clientView)).not.toContain(copy.agency.operatorsHeading)

    selectReportAudience('agency')
    const agencyView = getReportSection(SERVER_ACTIVITY)
    expect(agencyView.querySelector('[data-report-eyebrow]')?.textContent).toBe(copy.agency.eyebrow)
    expect(headings(agencyView)).toContain(copy.agency.operatorsHeading)
  })
})

describe('agency server activity', () => {
  test('four tiles carry the window label and the HTML prior-window deltas, toned by direction', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(SERVER_ACTIVITY)
    expect(tileLabels(section)).toEqual([
      'Verified crawler hits (7d)',
      'Unverified crawler hits (7d)',
      'AI user-fetch hits (7d)',
      'AI-referral sessions (7d)',
    ])

    const verified = tile(section, 'Verified crawler hits (7d)')
    expect(verified.value.textContent).toBe('234')
    expect(verified.subtitle?.textContent).toBe('Up 100% vs prior 7 days (117 hits)')
    expect(within(verified.subtitle!).getByText('Up 100% vs prior 7 days (117 hits)').className).toContain('text-positive-400')

    const unverified = tile(section, 'Unverified crawler hits (7d)')
    expect(unverified.value.textContent).toBe('15')
    expect(unverified.subtitle?.textContent).toBe('Up 200.0% vs prior 7 days (5 hits)')

    const userFetches = tile(section, 'AI user-fetch hits (7d)')
    expect(userFetches.value.textContent).toBe('42')
    expect(userFetches.subtitle?.textContent).toBe('Up 133.3% vs prior 7 days (18 hits)')

    // The referral line joins the delta, the paid/organic split and the redirect note, in the HTML order.
    const referral = tile(section, 'AI-referral sessions (7d)')
    expect(referral.value.textContent).toBe('12')
    expect(referral.subtitle?.textContent).toBe('Up 100% vs prior 7 days (6 sessions) · Paid 9 · Organic 2 · Unclassified 1 · 120 blocked by redirects')
    // Only the delta carries the tone.
    expect(within(referral.subtitle!).getByText('Up 100% vs prior 7 days (6 sessions)').className).toContain('text-positive-400')
    expect(within(referral.subtitle!).getByText(/Paid 9 · Organic 2 · Unclassified 1/).className).not.toMatch(TONED)
  })

  test('a falling, flat, first-baseline or copy-less delta reads the way the HTML report writes it', () => {
    const report = fullReport()
    report.serverActivity = {
      ...report.serverActivity!,
      // 117 → 90 is -23.08%, the two-decimal deltaPct the report sends.
      verifiedCrawlerHits: { current: 90, prior: 117, deltaPct: -23.08 },
      unverifiedCrawlerHits: { current: 5, prior: 5, deltaPct: 0 },
      aiUserFetchHits: { current: 42, prior: 0, deltaPct: null },
      referralArrivals: { current: 12, prior: 6, deltaPct: null },
    }
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(SERVER_ACTIVITY)

    const down = within(tile(section, 'Verified crawler hits (7d)').subtitle!).getByText('Down 23.1% vs prior 7 days (117 hits)')
    expect(down.className).toContain('text-negative-400')
    const flat = within(tile(section, 'Unverified crawler hits (7d)').subtitle!).getByText('Flat vs prior 7 days (5 hits)')
    expect(flat.className).not.toMatch(TONED)
    expect(tile(section, 'AI user-fetch hits (7d)').subtitle?.textContent).toBe('First baseline week')
    // A delta with no copy drops out of the referral line without leaving a separator behind.
    expect(tile(section, 'AI-referral sessions (7d)').subtitle?.textContent).toBe('Paid 9 · Organic 2 · Unclassified 1 · 120 blocked by redirects')
  })

  test('a tile with nothing to say under its value shows no line', () => {
    const report = richReport()
    report.serverActivity = {
      ...report.serverActivity!,
      verifiedCrawlerHits: { current: 20, prior: 3, deltaPct: null },
      referralArrivals: { current: 4, prior: 2, deltaPct: null },
      referralArrivalsClassSummary: '',
      referralRedirects: 0,
    }
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(SERVER_ACTIVITY)
    expect(tile(section, 'Verified crawler hits (7d)').subtitle).toBeUndefined()
    expect(tile(section, 'AI-referral sessions (7d)').subtitle).toBeUndefined()
  })

  test('every window label follows the report period', () => {
    const report = fullReport()
    report.meta.periodDays = 30
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(SERVER_ACTIVITY)
    expect(tileLabels(section)).toEqual([
      'Verified crawler hits (30d)',
      'Unverified crawler hits (30d)',
      'AI user-fetch hits (30d)',
      'AI-referral sessions (30d)',
    ])
    expect(tile(section, 'Verified crawler hits (30d)').subtitle?.textContent).toBe('Up 100% vs prior 30 days (117 hits)')
    expect(headings(section)[0]).toBe('Verified crawler hits over time (last 30 days)')
    expect(within(section).getByRole('application', { name: 'Verified crawler hits over time (last 30 days) line chart' })).toBeTruthy()
    expect(headerCells(tables(section)[0]!)).toEqual(['Operator', 'Verified hits', 'Unverified', 'User fetches', 'Referral sessions', '30d delta'])
    expect(within(section).getByText('Pages AI bots fetched most often (verified only, last 30d).')).toBeTruthy()
  })

  test('the operator note is a tooltip beside its heading, and the four tables carry the HTML headers in order', () => {
    const copy = REPORT_SECTION_COPY['server-activity'].agency
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(SERVER_ACTIVITY)

    const note = within(section).getByRole('button', { name: /could be the real bot or an imitator/ })
    expect(note.getAttribute('aria-label')).toBe(copy.operatorsNote)
    expect(note.closest('h3')).toBeNull()

    expect(within(section).getByRole('application', { name: 'Verified crawler hits over time (last 7 days) line chart' })).toBeTruthy()
    expect(headings(section)).toEqual([
      'Verified crawler hits over time (last 7 days)',
      'Per AI operator',
      'Top crawled paths',
      'AI-referral sessions by product',
      'Top AI-referral landing paths',
    ])
    expect(tables(section).map(headerCells)).toEqual([
      ['Operator', 'Verified hits', 'Unverified', 'User fetches', 'Referral sessions', '7d delta'],
      ['Path', 'Hits', 'Verified', 'Distinct operators'],
      ['Product', 'Sessions', 'Distinct landing paths'],
      ['Path', 'Sessions', 'Distinct products'],
    ])
    expect(within(section).getByText('Pages AI bots fetched most often (verified only, last 7d).')).toBeTruthy()
    expect(within(section).getByText(copy.referralProductsNote)).toBeTruthy()
    // Each table scrolls inside its own container instead of widening the page.
    for (const table of tables(section)) expect(table.parentElement?.className).toBe('evidence-table-wrap')
  })

  test('operator, crawled path, product and landing rows read like the HTML tables', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const serverTables = tables(getReportSection(SERVER_ACTIVITY))
    expect(serverTables).toHaveLength(4)
    const [operators, paths, products, landings] = serverTables

    // Every operator is listed, a user-fetch-only operator included.
    expect(bodyRows(operators!)).toEqual([
      ['OpenAI', '140', '10', '32', '8', '+75.0%'],
      ['Anthropic', '70', '0', '0', '3', '+40.0%'],
      ['Google AI', '24', '5', '0', '1', '—'],
      ['Perplexity', '0', '0', '10', '0', '—'],
    ])
    expect(bodyCell(operators!, '+75.0%').className).toContain('text-positive-400')
    expect(operators!.querySelector('tbody tr')?.querySelectorAll('td')[2]?.className).toContain('text-secondary')

    // Hits add the unverified crawl to the verified crawl: 80 + 15 = 95 and 50 + 0 = 50.
    expect(bodyRows(paths!)).toEqual([
      ['/blog/foo', '95', '80', '2'],
      ['/pricing', '50', '50', '1'],
    ])
    expect(bodyRows(products!)).toEqual([
      ['ChatGPT', '8', '3'],
      ['Claude', '3', '1'],
    ])
    expect(bodyRows(landings!)).toEqual([['/landing', '5', '2']])
  })

  test('a crawled path with no unverified hits counts its verified hits alone', () => {
    // richReport() records zero unverified hits on both of its crawled paths.
    renderReportPage(richReport(), { audience: 'agency' })
    const serverTables = tables(getReportSection(SERVER_ACTIVITY))
    expect(serverTables).toHaveLength(4)
    const [, paths] = serverTables
    expect(bodyRows(paths!)).toEqual([
      ['/blog/foo', '80', '80', '2'],
      ['/pricing', '50', '50', '1'],
    ])
  })

  test('an operator delta is signed and toned, zero stays untoned, and a missing delta is a dash', () => {
    const report = fullReport()
    report.serverActivity = {
      ...report.serverActivity!,
      byOperator: [
        // -33.33 is the two-decimal deltaPct the report sends for a third fewer hits.
        { operator: 'OpenAI', verifiedHits: 140, unverifiedHits: 10, userFetchHits: 32, referralArrivals: 8, deltaPct: -33.33 },
        { operator: 'Anthropic', verifiedHits: 70, unverifiedHits: 0, userFetchHits: 0, referralArrivals: 3, deltaPct: 0 },
        { operator: 'Google AI', verifiedHits: 24, unverifiedHits: 5, userFetchHits: 0, referralArrivals: 1, deltaPct: null },
      ],
    }
    renderReportPage(report, { audience: 'agency' })
    const serverTables = tables(getReportSection(SERVER_ACTIVITY))
    expect(serverTables).toHaveLength(4)
    const [operators] = serverTables
    expect(bodyRows(operators!).map(row => row[5])).toEqual(['-33.3%', '0%', '—'])
    expect(bodyCell(operators!, '-33.3%').className).toContain('text-negative-400')
    expect(bodyCell(operators!, '0%').className).not.toMatch(TONED)
    expect(bodyCell(operators!, '—').className).not.toMatch(TONED)
  })

  test('the chart and each table drop out, heading and note included, when they have nothing to show', () => {
    const report = fullReport()
    report.serverActivity = {
      ...report.serverActivity!,
      dailyTrend: [],
      byOperator: [],
      topCrawledPaths: [],
      referralProducts: [],
      topReferralLandingPaths: [],
    }
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(SERVER_ACTIVITY)
    expect(within(section).queryByRole('img')).toBeNull()
    expect(within(section).queryByRole('button')).toBeNull()
    expect(tables(section)).toEqual([])
    expect(reportOutlineSection(readReportOutline(document.body), SERVER_ACTIVITY)?.items).toEqual([
      { tile: 'Verified crawler hits (7d)' },
      { tile: 'Unverified crawler hits (7d)' },
      { tile: 'AI user-fetch hits (7d)' },
      { tile: 'AI-referral sessions (7d)' },
    ])
  })

  test('without a traffic source the agency sees the connect prompt under the full heading, and the client sees no section', () => {
    const copy = REPORT_SECTION_COPY['server-activity']
    const report = richReport()
    report.serverActivity = null
    renderReportPage(report)
    expect(document.getElementById(SERVER_ACTIVITY)).toBeNull()

    selectReportAudience('agency')
    expect(within(getReportSection(SERVER_ACTIVITY)).getByText(/^Connect a server-side traffic source/)).toBeTruthy()
    expect(reportOutlineSection(readReportOutline(document.body), SERVER_ACTIVITY)).toEqual({
      id: SERVER_ACTIVITY,
      eyebrow: copy.agency.eyebrow,
      title: copy.title,
      intro: copy.agency.intro,
      items: [{ empty: copy.agency.emptyNotConnected }],
      content: [{ text: copy.agency.emptyNotConnected }],
    })
  })

  test('a connected source with nothing synced keeps the agency intro and says it is collecting', () => {
    const copy = REPORT_SECTION_COPY['server-activity']
    const report = richReport()
    report.serverActivity = { ...report.serverActivity!, hasData: false }
    renderReportPage(report, { audience: 'agency' })
    expect(reportOutlineSection(readReportOutline(document.body), SERVER_ACTIVITY)).toEqual({
      id: SERVER_ACTIVITY,
      eyebrow: copy.agency.eyebrow,
      title: copy.title,
      intro: copy.agency.intro,
      items: [{ empty: copy.agency.empty }],
      content: [{ text: copy.agency.empty }],
    })
  })
})

describe('agency indexing health', () => {
  test('three tiles lead with the indexed count in the positive tone, then a coverage bar named like the HTML chart', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(INDEXING_HEALTH)
    expect(sectionIntro(section)).toBe('Pages absent from Google are harder for AI engines to retrieve.')
    expect(tileLabels(section)).toEqual(['Indexed', 'Total inspected', 'Indexed share'])
    expect(['Indexed', 'Total inspected', 'Indexed share'].map(label => tile(section, label).value.textContent)).toEqual(['80', '100', '80.0%'])
    expect(tile(section, 'Indexed').value.className).toContain('text-positive-400')
    expect(tile(section, 'Total inspected').value.className).not.toMatch(TONED)
    expect(within(section).getByRole('img', { name: 'Coverage stacked bar' })).toBeTruthy()
  })

  test('the legend names each non-empty segment with its count and leaves the empty ones out', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(INDEXING_HEALTH)
    expect(within(section).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Indexed: 80', 'Not indexed: 20'])
    expect(within(section).queryByText(/Deindexed:/)).toBeNull()
    expect(within(section).queryByText(/Unknown:/)).toBeNull()
  })

  test('a Bing source names Bing and lists only the segments Bing reports', () => {
    const report = fullReport()
    report.indexingHealth = { provider: 'bing', total: 100, indexed: 80, notIndexed: 15, deindexed: 0, unknown: 5, indexedPct: 80 }
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(INDEXING_HEALTH)
    expect(sectionIntro(section)).toBe('Pages absent from Bing are harder for AI engines to retrieve.')
    expect(within(section).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Indexed: 80', 'Not indexed: 15', 'Unknown: 5'])
  })
})

describe('agency citations trend', () => {
  test('a trend long enough to chart draws the rate line and one breakdown row per check', () => {
    const report = fullReport()
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(CITATIONS_TREND)
    expect(sectionIntro(section)).toBe('Citation coverage across recent checks.')
    expect(within(section).getByRole('application', { name: 'Overall citation rate line chart' })).toBeTruthy()
    const [breakdown] = tables(section)
    expect(headerCells(breakdown!)).toEqual(['Check', 'Cited queries', 'Per-engine rates'])
    // Check dates are run timestamps: the label is built the way the page builds it, in the viewer's timezone.
    const checks = report.citationsTrend.map(point => formatDate(point.date))
    expect(bodyRows(breakdown!)).toEqual([
      [checks[0], '50.0% (2/4)', 'gemini: 50.0% · openai: 25.0%'],
      [checks[1], '55.0% (2/4)', 'gemini: 55.0% · openai: 30.0%'],
      [checks[2], '60.0% (3/5)', 'gemini: 60.0% · openai: 40.0%'],
      [checks[3], '65.0% (3/5)', 'gemini: 65.0% · openai: 50.0%'],
    ])
  })

  test('the change-history report charts its four checks', () => {
    renderReportPage(reportWithChangeHistory(), { audience: 'agency' })
    const section = getReportSection(CITATIONS_TREND)
    expect(within(section).getByRole('application', { name: 'Overall citation rate line chart' })).toBeTruthy()
    expect(bodyRows(tables(section)[0]!)).toHaveLength(4)
  })

  test.each(Array.from({ length: MIN_TREND_POINTS - 1 }, (_, index) => index + 1))('%i recorded checks show the HTML baseline sentence, with no intro, chart or table', (points) => {
    const report = fullReport()
    report.citationsTrend = report.citationsTrend.slice(0, points)
    renderReportPage(report, { audience: 'agency' })
    expect(reportOutlineSection(readReportOutline(document.body), CITATIONS_TREND)).toEqual({
      id: CITATIONS_TREND,
      eyebrow: REPORT_SECTION_COPY['citations-trend'].eyebrow,
      title: REPORT_SECTION_COPY['citations-trend'].title,
      intro: null,
      items: [{ empty: reportCitationsTrendBaseline(points) }],
      content: [{ text: reportCitationsTrendBaseline(points) }],
    })
    expect(within(getReportSection(CITATIONS_TREND)).queryByRole('img')).toBeNull()
  })

  test('no recorded checks shows the HTML empty state with no intro', () => {
    const report = fullReport()
    report.citationsTrend = []
    renderReportPage(report, { audience: 'agency' })
    expect(reportOutlineSection(readReportOutline(document.body), CITATIONS_TREND)).toEqual({
      id: CITATIONS_TREND,
      eyebrow: REPORT_SECTION_COPY['citations-trend'].eyebrow,
      title: REPORT_SECTION_COPY['citations-trend'].title,
      intro: null,
      items: [{ empty: 'Run multiple checks to see a trend.' }],
      content: [{ text: 'Run multiple checks to see a trend.' }],
    })
  })

  test('the advanced report keeps server activity and indexing health but has no citations trend', () => {
    renderReportPage(advancedReport(), { audience: 'agency' })
    expect(queryReportSection(SERVER_ACTIVITY)).not.toBeNull()
    expect(queryReportSection(INDEXING_HEALTH)).not.toBeNull()
    expect(queryReportSection(CITATIONS_TREND)).toBeNull()
  })
})
