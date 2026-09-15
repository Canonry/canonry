/**
 * Agency report slice S5: insights, content opportunities and content gaps.
 *
 * The in-app report must read the way the downloadable HTML report does
 * (packages/api-routes/src/report-renderer.ts: renderInsights,
 * renderOpportunities, renderContentGaps). Section outlines are compared with
 * the committed HTML goldens; the rest pins the cell-level behavior the
 * outline cannot see.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { within } from '@testing-library/react'
import { ReportSectionIds, type ProjectReportDto, type ReportSectionId } from '@ainyc/canonry-contracts'
import { advancedReport, emptyReport, fullReport, richReport } from '../../../packages/contracts/test/fixtures/report-dto.js'
import { cleanupReportPage, getReportSection, queryReportSection, renderReportPage } from './report-page-harness.js'
import { readReportOutline, reportOutlineGolden, reportOutlineSection, type ReportOutlineFixture } from './report-outline.js'

vi.mock('recharts', () => import('./report-recharts-stub.js'))

afterEach(cleanupReportPage)

const CONTENT_SECTIONS: readonly ReportSectionId[] = [
  ReportSectionIds.insights,
  ReportSectionIds['content-opportunities'],
  ReportSectionIds['content-gaps'],
]

const OUTLINE_FIXTURES: Array<[ReportOutlineFixture, () => ProjectReportDto]> = [
  ['empty', emptyReport],
  ['full', fullReport],
  ['advanced', advancedReport],
]

/** Which of these sections each fixture shows: opportunities and gaps drop out when the report has none. */
const PRESENT_SECTIONS: Readonly<Record<ReportOutlineFixture, readonly ReportSectionId[]>> = {
  empty: [ReportSectionIds.insights],
  full: CONTENT_SECTIONS,
  advanced: CONTENT_SECTIONS,
}

type ContentOpportunity = ProjectReportDto['contentOpportunities'][number]

/** A copy of the report's first opportunity under a new query, so the report's intent dedupe keeps it. */
function opportunity(report: ProjectReportDto, query: string, overrides: Partial<ContentOpportunity> = {}): ContentOpportunity {
  const [first] = report.contentOpportunities
  if (!first) throw new Error('the report has no opportunity to copy')
  return { ...first, targetRef: `rich:create:${query}`, query, ...overrides }
}

function sectionTable(id: ReportSectionId): HTMLTableElement {
  const table = getReportSection(id).querySelector('table')
  if (!table) throw new Error(`Report section "${id}" has no table`)
  return table
}

function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
  return Array.from(table.querySelectorAll<HTMLTableCellElement>('thead th'))
}

function bodyRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr'))
}

function cellTexts(row: HTMLTableRowElement): string[] {
  return Array.from(row.cells, cell => cell.textContent ?? '')
}

describe('parity with the HTML report outline', () => {
  test.each(OUTLINE_FIXTURES)('the agency insights and content sections of the %s report match the HTML outline', (name, build) => {
    renderReportPage(build(), { audience: 'agency' })
    const outline = readReportOutline(document.body)
    const golden = reportOutlineGolden('agency', name)
    expect(CONTENT_SECTIONS.filter(id => queryReportSection(id) !== null)).toEqual(PRESENT_SECTIONS[name])
    for (const id of CONTENT_SECTIONS) {
      expect(reportOutlineSection(outline, id), id).toEqual(reportOutlineSection(golden, id))
    }
  })

  test.each([['full', fullReport], ['advanced', advancedReport]] as const)('the client audience of the %s report renders none of these sections', (_name, build) => {
    renderReportPage(build())
    for (const id of CONTENT_SECTIONS) expect(queryReportSection(id), id).toBeNull()
  })

  test('a report with no opportunities and no gaps leaves both sections out of the agency view and keeps insights', () => {
    const report = richReport()
    report.contentOpportunities = []
    report.contentGaps = []
    renderReportPage(report, { audience: 'agency' })
    expect(queryReportSection(ReportSectionIds['content-opportunities'])).toBeNull()
    expect(queryReportSection(ReportSectionIds['content-gaps'])).toBeNull()
    expect(queryReportSection(ReportSectionIds.insights)).not.toBeNull()
  })
})

describe('insights', () => {
  test('severity reads as its label in its tone, and the provider stays the raw id', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const [critical, medium] = bodyRows(sectionTable(ReportSectionIds.insights))
    const criticalBadge = within(critical.cells[0]).getByText('Critical')
    expect(within(critical).queryByText('critical')).toBeNull()
    expect(criticalBadge.classList.contains('text-negative')).toBe(true)
    expect(within(medium.cells[0]).getByText('Medium').classList.contains('text-caution')).toBe(true)
    expect([critical.cells[2].textContent, critical.cells[3].textContent]).toEqual(['aeo platform', 'gemini'])
    expect([medium.cells[2].textContent, medium.cells[3].textContent]).toEqual(['best aeo platform', 'openai'])
  })

  test('a repeated insight carries a neutral × 3 badge in its title cell, and a missing recommendation reads —', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const [repeated, single] = bodyRows(sectionTable(ReportSectionIds.insights))
    expect(within(repeated.cells[1]).getByText('× 3').classList.contains('text-neutral')).toBe(true)
    expect(repeated.cells[1].textContent).toBe('Lost citation on aeo platform× 3')
    expect(single.cells[1].textContent).toBe('Opportunity on best aeo platform')
    expect(repeated.cells[4].textContent).toBe('review-content — /landing — rival outranking')
    expect(single.cells[4].textContent).toBe('—')
  })

  test('the insights table keeps the fixed column widths and 680px minimum width of the HTML report', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const table = sectionTable(ReportSectionIds.insights)
    expect(table.closest('.evidence-table-wrap')).not.toBeNull()
    expect(table.classList.contains('table-fixed')).toBe(true)
    expect(table.classList.contains('min-w-[680px]')).toBe(true)
    expect(headerCells(table).map(cell => [cell.textContent, cell.className])).toEqual([
      ['Severity', 'w-24'],
      ['Title', 'w-[28%]'],
      ['Query', 'w-[18%]'],
      ['Provider', 'w-[88px]'],
      ['Recommendation', 'w-auto'],
    ])
  })

  test('a report without insights shows the HTML empty state with no intro and no table', () => {
    renderReportPage(emptyReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds.insights)
    expect(within(section).getByText('No insights yet — run a check to generate alerts.')).toBeTruthy()
    expect(section.querySelector('[data-report-intro]')).toBeNull()
    expect(section.querySelector('table')).toBeNull()
  })
})

describe('content opportunities', () => {
  test('the top three opportunities become cards: the rounded score out of 100, the action line, and at most two drivers', () => {
    const report = fullReport()
    report.contentOpportunities.push(
      opportunity(report, 'aeo audit checklist', { score: 51.4, drivers: ['thin schema', 'no faq', 'slow page'] }),
      opportunity(report, 'llm seo agency', { score: 40 }),
    )
    renderReportPage(report, { audience: 'agency' })
    const cards = Array.from(getReportSection(ReportSectionIds['content-opportunities']).querySelectorAll('article'))
    expect(cards.map(card => within(card).getByRole('heading').textContent)).toEqual(['best aeo platform', 'answer engine optimization', 'aeo audit checklist'])

    const [best, answer, audit] = cards
    expect(within(best).getByText('/100').parentElement?.textContent).toBe('88/100')
    expect(within(best).getByRole('button', { name: 'Opportunity score (0–100, higher = stronger)' })).toBeTruthy()
    expect(within(best).getByText('Create · High confidence')).toBeTruthy()
    expect(within(best).getByText('high competitor density')).toBeTruthy()
    expect(within(best).getByText('no own page')).toBeTruthy()
    expect(within(answer).getByText('/100').parentElement?.textContent).toBe('62/100')
    expect(within(answer).getByText('Refresh · Medium confidence')).toBeTruthy()
    expect(within(audit).getByText('/100').parentElement?.textContent).toBe('51/100')
    expect(within(audit).getByText('thin schema')).toBeTruthy()
    expect(within(audit).getByText('no faq')).toBeTruthy()
    expect(within(audit).queryByText('slow page')).toBeNull()
    expect(within(audit).getByText('+1 more')).toBeTruthy()

    expect(bodyRows(sectionTable(ReportSectionIds['content-opportunities'])).map(row => row.cells[0].textContent))
      .toEqual(['best aeo platform', 'answer engine optimization', 'aeo audit checklist', 'llm seo agency'])
  })

  test('the table lists the top ten opportunities', () => {
    const report = fullReport()
    report.contentOpportunities = Array.from({ length: 12 }, (_, index) => opportunity(report, `aeo topic ${index + 1}`))
    renderReportPage(report, { audience: 'agency' })
    expect(getReportSection(ReportSectionIds['content-opportunities']).querySelectorAll('article')).toHaveLength(3)
    expect(bodyRows(sectionTable(ReportSectionIds['content-opportunities'])).map(row => row.cells[0].textContent))
      .toEqual(Array.from({ length: 10 }, (_, index) => `aeo topic ${index + 1}`))
  })

  test('cards and rows come from the deduped opportunities the HTML report lists', () => {
    const report = fullReport()
    // "michigan" is the report market, so this is the same intent as "best aeo platform".
    report.contentOpportunities.push(opportunity(report, 'best aeo platform in michigan'))
    renderReportPage(report, { audience: 'agency' })
    expect(getReportSection(ReportSectionIds['content-opportunities']).querySelectorAll('article')).toHaveLength(2)
    expect(bodyRows(sectionTable(ReportSectionIds['content-opportunities'])).map(row => row.cells[0].textContent))
      .toEqual(['best aeo platform', 'answer engine optimization'])
  })

  test('rows carry neutral action and confidence badges, caution winnability only when ceded, and the HTML placeholders', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const table = sectionTable(ReportSectionIds['content-opportunities'])
    const [ownable, ceded] = bodyRows(table)
    expect(cellTexts(ownable)).toEqual(['best aeo platform', 'Create', 'Ownable', '88', 'high competitor densityno own page', 'No page yet', 'rival.com', 'High'])
    expect(cellTexts(ceded)).toEqual(['answer engine optimization', 'Refresh', 'Ceded', '62', 'existing page ranks weakly', '/blog/answer-engine-optimization', '—', 'Medium'])
    expect(within(ownable.cells[1]).getByText('Create').classList.contains('text-neutral')).toBe(true)
    expect(within(ownable.cells[2]).getByText('Ownable').classList.contains('text-neutral')).toBe(true)
    expect(within(ceded.cells[2]).getByText('Ceded').classList.contains('text-caution')).toBe(true)
    expect(within(ownable.cells[7]).getByText('High').classList.contains('text-neutral')).toBe(true)
    expect(Array.from(ownable.cells[4].querySelectorAll('li'), item => item.textContent)).toEqual(['high competitor density', 'no own page'])
    expect(within(ownable.cells[6]).getByRole('link', { name: 'rival.com' }).getAttribute('href')).toBe('https://rival.com/best-aeo')
    const scoreHeader = headerCells(table)[3]
    expect(scoreHeader.classList.contains('text-right')).toBe(true)
    expect(within(scoreHeader).getByRole('button', { name: 'Opportunity score (0–100)' })).toBeTruthy()
  })

  test('an opportunity without drivers says there is no driver signal yet', () => {
    const report = fullReport()
    report.contentOpportunities[0].drivers = []
    renderReportPage(report, { audience: 'agency' })
    const [first] = bodyRows(sectionTable(ReportSectionIds['content-opportunities']))
    expect(first.cells[4].textContent).toBe('No driver signal yet')
  })

  test('links open in a new tab: a path-only page is made absolute on the project domain, and a javascript: competitor URL links to #', () => {
    const report = fullReport()
    report.contentOpportunities[0].winningCompetitor!.url = 'javascript:alert(1)'
    renderReportPage(report, { audience: 'agency' })
    const table = sectionTable(ReportSectionIds['content-opportunities'])
    const page = within(table).getByRole('link', { name: '/blog/answer-engine-optimization' })
    expect(page.getAttribute('href')).toBe('https://rich.example.com/blog/answer-engine-optimization')
    expect(page.getAttribute('target')).toBe('_blank')
    expect(page.getAttribute('rel')).toBe('noopener noreferrer')
    expect(within(table).getByRole('link', { name: 'rival.com' }).getAttribute('href')).toBe('#')
  })
})

describe('content gaps', () => {
  test('a gap lists its first five competitor domains then +N more, and rounds its miss rate to a whole percent', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const table = sectionTable(ReportSectionIds['content-gaps'])
    expect(bodyRows(table).map(row => cellTexts(row))).toEqual([
      ['best aeo platform', '1', 'rival.com', '100%'],
      ['aeo software comparison', '6', 'a.com, b.com, c.com, d.com, e.com, +1 more', '50%'],
    ])
    expect(headerCells(table).map(cell => cell.classList.contains('text-right'))).toEqual([false, true, false, true])
  })

  test('the gaps table lists the top ten gaps', () => {
    const report = fullReport()
    report.contentGaps = Array.from({ length: 12 }, (_, index) => ({
      query: `gap ${index + 1}`,
      competitorDomains: ['rival.com'],
      competitorCount: 1,
      missRate: 0.334,
      lastSeenInRunId: 'r-4',
    }))
    renderReportPage(report, { audience: 'agency' })
    const rows = bodyRows(sectionTable(ReportSectionIds['content-gaps']))
    expect(rows.map(row => row.cells[0].textContent)).toEqual(Array.from({ length: 10 }, (_, index) => `gap ${index + 1}`))
    expect(rows[0].cells[3].textContent).toBe('33%')
  })
})
