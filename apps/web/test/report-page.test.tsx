import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  formatDate,
  REPORT_SECTION_COPY,
  ReportSectionIds,
  reportActionConfidenceBadge,
  reportActionHorizonBadge,
  reportMoreChipLabel,
  reportSectionOrder,
  type ProjectReportDto,
} from '@ainyc/canonry-contracts'
import { advancedReport, emptyReport, fullReport, richReport, simpleVisibility, truncatedReport } from '../../../packages/contracts/test/fixtures/report-dto.js'
import { downloadReportHtml } from '../src/api.js'
import { ReportPage } from '../src/pages/ReportPage.js'
import { cleanupReportPage, getReportSection, queryReportSection, renderReportPage, selectReportAudience } from './report-page-harness.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import {
  pinReportGoldenTimeZone,
  readReportOutline,
  readReportSectionIds,
  reportOutlineGolden,
  reportOutlineSection,
  type ReportOutlineFixture,
} from './report-outline.js'

vi.mock('recharts', () => import('./report-recharts-stub.js'))
vi.mock('../src/api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/api.js')>(),
  downloadReportHtml: vi.fn(async () => undefined),
}))

pinReportGoldenTimeZone()

afterEach(() => {
  cleanupReportPage()
  vi.mocked(downloadReportHtml).mockClear()
})

const OUTLINE_FIXTURES: Array<[ReportOutlineFixture, () => ProjectReportDto]> = [
  ['empty', emptyReport],
  ['full', fullReport],
  ['advanced', advancedReport],
  // Every list long enough to reach a renderer cap. The caps are paired across
  // the two surfaces and no other fixture exercises one.
  ['truncated', truncatedReport],
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

    // The period has to MOVE for this to test anything: asserting only the
    // default passes just as well if the button always asks for 30 days.
    fireEvent.click(within(screen.getByRole('group', { name: 'Report time period' })).getByRole('button', { name: '7d' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download report HTML' }))
    await vi.waitFor(() => expect(downloadReportHtml).toHaveBeenLastCalledWith('rich', 'agency', 7))
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

  // The whole outline, not just each section's eyebrow and title: comparing
  // headings alone left every agency heading, tile label, table header, note
  // and empty state inside those sections unguarded on this surface. The
  // outline's `content` carries the rest of what a reader reads — tile values
  // and subtitles, table body cells, badges and deltas with their tone, list
  // rows, link targets and details summaries — so this one assertion is what
  // stops the two surfaces disagreeing about the numbers in them.
  test.each(OUTLINE_FIXTURES)('the agency view of the %s report matches the HTML outline', (name, build) => {
    renderReportPage(build(), { audience: 'agency' })
    expect(readReportOutline(document.body)).toEqual(reportOutlineGolden('agency', name))
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
      content: [{ text: copy.client.empty }],
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

/**
 * What's Changed, below the outline. The outline records tile LABELS and table
 * HEADERS but never a value, a body row or a badge, so the numbers each tile is
 * bound to and the rows each table prints are pinned here instead.
 */
describe("what's changed", () => {
  const { client, agency } = REPORT_SECTION_COPY['whats-changed']

  /** A tile's value and the line under it, by label. */
  function tile(section: HTMLElement, label: string): { value: string; subtitle: string } {
    const labelElement = Array.from(section.querySelectorAll<HTMLElement>('[data-report-tile]'))
      .find(element => element.textContent === label)
    const [, value, subtitle] = Array.from(labelElement?.parentElement?.children ?? []) as Array<HTMLElement | undefined>
    if (!value) throw new Error(`No tile labelled "${label}"`)
    return { value: value.textContent ?? '', subtitle: subtitle?.textContent ?? '' }
  }

  const tables = (section: HTMLElement) => Array.from(section.querySelectorAll('table'))
  const rows = (table: HTMLTableElement) =>
    Array.from(table.querySelectorAll('tbody tr'), row => Array.from(row.querySelectorAll('td'), cell => cell.textContent ?? ''))

  // fullReport() moves citation and mention in OPPOSITE directions — citation
  // 65% and rising, mention 40% and falling — so a tile bound to the wrong
  // signal shows up here as a number, not just as a label.
  test('the agency tiles read the citation and mention deltas the HTML report binds', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['whats-changed'])
    expect(tile(section, agency.tiles.citationRate)).toEqual({ value: '65% ↑', subtitle: '+15.0% vs 50%' })
    expect(tile(section, agency.tiles.mentionRate)).toEqual({ value: '40% ↓', subtitle: '-5.0% vs 45%' })
    expect(tile(section, agency.tiles.citedQueryCount)).toEqual({ value: '3.3 ↑', subtitle: '+0.6 vs 2.7' })
    expect(tile(section, agency.tiles.gscClicks)).toEqual({ value: '520 ↑', subtitle: '+8% vs prior 14 days' })
    expect(tile(section, agency.tiles.aiReferrals)).toEqual({ value: '110 ↑', subtitle: '+22% vs prior 14 days' })
  })

  test('the client tiles lead with the mention delta, in the client audience’s words', () => {
    renderReportPage(fullReport())
    const section = getReportSection(ReportSectionIds['whats-changed'])
    expect(tile(section, client.tiles.mentionRate)).toEqual({ value: '40% ↓', subtitle: '-5.0% vs 45%' })
    expect(tile(section, client.tiles.citationRate)).toEqual({ value: '65% ↑', subtitle: '+15.0% vs 50%' })
    expect(tile(section, client.tiles.mentionedQueryCount)).toEqual({ value: '2 →', subtitle: '0 vs 2' })
    expect(tile(section, client.tiles.gscClicks)).toEqual({ value: '520 ↑', subtitle: '+8% vs prior 14 days' })
    expect(tile(section, client.tiles.aiReferrals)).toEqual({ value: '110 ↑', subtitle: '+22% vs prior 14 days' })
  })

  test('movement, win and regression rows read like the HTML tables in each audience', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const [movements, wins, regressions] = tables(getReportSection(ReportSectionIds['whats-changed']))
    // openai moved one point and counts as flat; the HTML drops flat rows.
    expect(rows(movements!)).toEqual([['gemini', '50%', '65%', '+15.0% ↑']])
    expect(rows(wins!)).toEqual([['High', 'Gained citation on answer engine× 2', 'answer engine', 'gemini']])
    expect(rows(regressions!)).toEqual([['Critical', 'Lost citation on aeo platform', 'aeo platform', 'gemini']])

    cleanupReportPage()
    renderReportPage(fullReport())
    const [clientMovements, clientWins, clientRegressions] = tables(getReportSection(ReportSectionIds['whats-changed']))
    // The client view names the engine and drops the severity column.
    expect(rows(clientMovements!)).toEqual([['Gemini', '50%', '65%', '+15.0% ↑']])
    expect(rows(clientWins!)).toEqual([['Gained citation on answer engine× 2', 'answer engine', 'Gemini']])
    expect(rows(clientRegressions!)).toEqual([['Lost citation on aeo platform', 'aeo platform', 'Gemini']])
  })

  // No fixture renders this state, so neither renderer's empty branch was ever
  // compared: enough history to show the tiles, but nothing new either way.
  test.each(['client', 'agency'] as const)('%s: history with no new wins or regressions prints the HTML note under each heading', (audience) => {
    const report = fullReport()
    report.whatsChanged.wins = []
    report.whatsChanged.regressions = []
    renderReportPage(report, { audience })
    const section = getReportSection(ReportSectionIds['whats-changed'])
    const copy = audience === 'client' ? client : agency
    for (const text of [copy.winsHeading, copy.winsEmpty, copy.regressionsHeading, copy.regressionsEmpty]) {
      expect(within(section).getByText(text), text).toBeTruthy()
    }
    // Only the engine-movement table is left; the two row tables are gone.
    expect(tables(section)).toHaveLength(1)
  })
})

describe('action plan cards', () => {
  const actionTitle = 'Create content for "best aeo platform"'

  const cardFor = (audience: 'client' | 'agency') =>
    within(getReportSection(audience === 'client' ? ReportSectionIds['client-action-plan'] : ReportSectionIds['agency-action-plan']))
      .getByText(actionTitle).closest('article')!

  test.each(['client', 'agency'] as const)('%s cards carry that audience’s horizon, confidence and success wording', (audience) => {
    renderReportPage(fullReport(), { audience })
    const card = cardFor(audience)
    const copy = audience === 'client' ? REPORT_SECTION_COPY['client-action-plan'] : REPORT_SECTION_COPY['agency-action-plan']
    expect(within(card).getByText(reportActionHorizonBadge(audience, 'short-term'))).toBeTruthy()
    expect(within(card).getByText(reportActionConfidenceBadge(audience, 'high'))).toBeTruthy()
    expect(within(card).getByText(copy.successLabel)).toBeTruthy()
  })

  test('an action with more evidence than the card shows counts the rest in one chip', () => {
    const report = fullReport()
    report.clientSummary.actionItems[0]!.evidence = ['one', 'two', 'three', 'four']
    renderReportPage(report)
    const overflow = within(cardFor('client')).getByText(reportMoreChipLabel(1))
    expect(Array.from(overflow.parentElement!.children, chip => chip.textContent))
      .toEqual(['one', 'two', 'three', reportMoreChipLabel(1)])
  })
})

describe('report heading', () => {
  test('keeps the heading while the report query loads', () => {
    const restore = mockFetch(() => new Promise(() => {}))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ReportPage projectName="acme" projectTitle="Acme Co" />
      </QueryClientProvider>,
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Acme Co')
    expect(screen.getByText('Loading report…')).toBeTruthy()
    restore()
    queryClient.clear()
  })

  test('keeps the heading when the report query fails', async () => {
    const restore = mockFetch(() => jsonResponse({ error: 'unavailable' }, 500))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ReportPage projectName="acme" projectTitle="Acme Co" />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText('Failed to load report')).toBeTruthy())
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Acme Co')
    restore()
    queryClient.clear()
  })
})
