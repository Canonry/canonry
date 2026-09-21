/**
 * Agency report slice S2, competitive evidence: the citation scorecard, the
 * competitor landscape and the AI citation sources.
 *
 * The HTML report (packages/api-routes/src/report-renderer.ts) is the
 * reference. Its committed outline goldens pin the headings, tables, notes and
 * empty states; the tests below pin the rest of what it draws from the same
 * DTO: the matrix glyphs, the table cells, the chart rows and scales, the
 * cited-URL links, and every branch that adds or drops a block.
 */
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { within } from '@testing-library/react'
import { ReportSectionIds, type MentionLandscape, type ProjectReportDto } from '@ainyc/canonry-contracts'
import { advancedReport, emptyReport, fullReport, richReport } from '../../../packages/contracts/test/fixtures/report-dto.js'
import { CHART_NEUTRAL, CHART_SERIES_COLORS, CHART_TONE } from '../src/components/shared/ChartPrimitives.js'
import { cleanupReportPage, getReportSection, queryReportSection, renderReportPage } from './report-page-harness.js'
import {
  normalizeOutlineText,
  pinReportGoldenTimeZone,
  readReportOutline,
  reportOutlineGolden,
  reportOutlineSection,
  type ReportOutlineFixture,
  type ReportOutlineSection,
} from './report-outline.js'

// The shared stub draws nothing for a bar chart. These stand-ins also expose
// what a report bar chart was given (its rows, its scale and its track), so the
// chart arithmetic can be held to the HTML report's.
vi.mock('recharts', async () => {
  const { createElement } = await import('react')
  const stub = await import('./report-recharts-stub.js')
  return {
    ...stub,
    BarChart: ({ data, children }: { data?: readonly unknown[]; children?: ReactNode }) =>
      createElement('div', { 'data-chart-rows': JSON.stringify(data ?? []) }, children),
    XAxis: ({ domain }: { domain?: unknown }) => createElement('span', { 'data-chart-domain': JSON.stringify(domain ?? null) }),
    Bar: ({ background, children }: { background?: unknown; children?: ReactNode }) =>
      createElement('div', { 'data-chart-track': JSON.stringify(background ?? false) }, children),
  }
})

pinReportGoldenTimeZone()
afterEach(cleanupReportPage)

const COMPETITIVE_SECTIONS = [
  ReportSectionIds['citation-scorecard'],
  ReportSectionIds['competitor-landscape'],
  ReportSectionIds['ai-source-origin'],
] as const

const OUTLINE_FIXTURES: Array<[ReportOutlineFixture, () => ProjectReportDto]> = [
  ['empty', emptyReport],
  ['full', fullReport],
  ['advanced', advancedReport],
]

const LANDSCAPE_HEADERS = ['Domain', 'Pressure', 'Citations', 'Mentions (non-brand queries)', 'Citation share', 'Cited queries']
const BRANDED_NOTE = "Branded queries contain the client's own name. The client is named on nearly all of them and a competitor structurally cannot be, so these are kept out of the competitive figure above. Read them as brand recall: 2 of 2 branded answers named the client."

interface ChartRow {
  label: string
  value: number
  color: string
  valueLabel: string
}

/** Render the agency report and read one section's outline. */
function agencyOutlineSection(report: ProjectReportDto, id: string): ReportOutlineSection | undefined {
  renderReportPage(report, { audience: 'agency' })
  return reportOutlineSection(readReportOutline(document.body), id)
}

/** What the section's bar chart with this title was asked to draw. */
function barChart(section: HTMLElement, title: string): { rows: ChartRow[]; domain: unknown; track: unknown } {
  const chart = within(section).getByRole('img', { name: `${title} bar chart` })
  const read = (attribute: string): unknown => JSON.parse(chart.querySelector(`[${attribute}]`)?.getAttribute(attribute) ?? 'null')
  return { rows: read('data-chart-rows') as ChartRow[], domain: read('data-chart-domain'), track: read('data-chart-track') }
}

/** The section's table whose first header reads `firstHeader`. */
function sectionTable(section: HTMLElement, firstHeader: string): HTMLTableElement {
  const table = Array.from(section.querySelectorAll('table'))
    .find(candidate => normalizeOutlineText(candidate.tHead?.rows[0]?.cells[0]?.textContent) === firstHeader)
  if (!table) throw new Error(`No table starting with "${firstHeader}"`)
  return table
}

function headerTexts(table: HTMLTableElement): string[] {
  return Array.from(table.tHead?.rows[0]?.cells ?? [], cell => normalizeOutlineText(cell.textContent))
}

function bodyRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.tBodies[0]?.rows ?? [])
}

function cellTexts(row: HTMLTableRowElement): string[] {
  return Array.from(row.cells, cell => normalizeOutlineText(cell.textContent))
}

/** Silence every mention: no tracked brand named, so each competitor's mention share is null. */
function withNoBrandNamed(report: ProjectReportDto): void {
  const silent = report.mentionLandscape.competitors.map(row => ({ ...row, mentionCount: 0, mentionedQueries: [], pressureLabel: 'None' as const, sharePct: null }))
  report.mentionLandscape = {
    ...report.mentionLandscape,
    projectMentionCount: 0,
    competitors: silent,
    nonBrand: { projectMentionCount: 0, totalAnswerSnapshots: report.mentionLandscape.totalAnswerSnapshots, competitors: silent },
  }
}

describe('parity with the HTML report outline', () => {
  test.each(OUTLINE_FIXTURES)('the competitive evidence sections of the %s report match the HTML outline', (name, build) => {
    renderReportPage(build(), { audience: 'agency' })
    const outline = readReportOutline(document.body)
    const golden = reportOutlineGolden('agency', name)
    for (const id of COMPETITIVE_SECTIONS) {
      expect(reportOutlineSection(outline, id), id).toEqual(reportOutlineSection(golden, id))
    }
  })

  test('the full and empty goldens hold all three sections, so their comparison is never between two absences', () => {
    for (const fixture of ['empty', 'full'] as const) {
      const golden = reportOutlineGolden('agency', fixture)
      for (const id of COMPETITIVE_SECTIONS) expect(reportOutlineSection(golden, id), `${fixture} ${id}`).toBeDefined()
    }
  })

  test('an Advanced report drops the scorecard and the landscape and keeps the citation sources', () => {
    renderReportPage(advancedReport(), { audience: 'agency' })
    expect(queryReportSection(ReportSectionIds['citation-scorecard'])).toBeNull()
    expect(queryReportSection(ReportSectionIds['competitor-landscape'])).toBeNull()
    expect(getReportSection(ReportSectionIds['ai-source-origin'])).toBeTruthy()
  })

  test('the client audience renders none of these sections', () => {
    renderReportPage(fullReport())
    for (const id of COMPETITIVE_SECTIONS) expect(queryReportSection(id), id).toBeNull()
  })

  test("an empty report shows each section's HTML empty state, keeping an intro on the scorecard only", () => {
    renderReportPage(emptyReport(), { audience: 'agency' })
    const outline = readReportOutline(document.body)
    expect(COMPETITIVE_SECTIONS.map(id => reportOutlineSection(outline, id))).toEqual([
      {
        id: 'citation-scorecard',
        eyebrow: 'Section 3',
        title: 'Citation Scorecard',
        intro: 'Per-engine citation and mention coverage from the latest check.',
        items: [{ empty: 'Run a check to populate the citation matrix.' }],
        content: [{ text: 'Run a check to populate the citation matrix.' }],
      },
      { id: 'competitor-landscape', eyebrow: 'Section 4', title: 'Competitor Landscape', intro: null, items: [{ empty: 'No competitor data yet. Add competitors and run a check.' }], content: [{ text: 'No competitor data yet. Add competitors and run a check.' }] },
      { id: 'ai-source-origin', eyebrow: 'Section 5', title: 'AI Citation Sources', intro: null, items: [{ empty: 'No source data yet. Run a check first.' }], content: [{ text: 'No source data yet. Run a check first.' }] },
    ])
  })
})

describe('citation scorecard', () => {
  test('each matrix cell reads citation then mention, and a missing cell reads — —', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['citation-scorecard'])
    const table = sectionTable(section, 'Query')
    expect(headerTexts(table)).toEqual(['Query', 'gemini', 'openai'])
    expect(bodyRows(table).map(cellTexts)).toEqual([
      ['aeo platform', 'C M', 'c m'],
      ['answer engine', 'c m', 'C M'],
      ['aeo tools', 'C –', '— —'],
    ])
    // Cited and mentioned glyphs carry the positive tone, as the HTML report's cell-cited class does.
    const [citedCell, notCitedCell] = Array.from(bodyRows(table)[0]!.cells).slice(1)
    expect(within(citedCell!).getByText('C').className).toContain('text-positive')
    expect(within(citedCell!).getByText('M').className).toContain('text-positive')
    expect(within(notCitedCell!).getByText('c').className).not.toContain('text-positive')
  })

  test('only a cited state earns the capital C, and an unknown mention stays –', () => {
    const report = fullReport()
    report.citationScorecard.matrix[0] = [
      { citationState: 'pending', answerMentioned: true, model: null },
      { citationState: 'not-cited', answerMentioned: null, model: null },
    ]
    renderReportPage(report, { audience: 'agency' })
    const table = sectionTable(getReportSection(ReportSectionIds['citation-scorecard']), 'Query')
    expect(cellTexts(bodyRows(table)[0]!)).toEqual(['aeo platform', 'c M', 'c –'])
  })

  test('the provider chart draws one bar per provider on a 0-100 track, labelled with the rate and its counts', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const chart = barChart(getReportSection(ReportSectionIds['citation-scorecard']), 'Provider citation rate')
    expect(chart.rows).toEqual([
      { label: 'gemini', value: 50, color: CHART_SERIES_COLORS[0], valueLabel: '50% (1/2)' },
      { label: 'openai', value: 50, color: CHART_SERIES_COLORS[1], valueLabel: '50% (1/2)' },
    ])
    expect(chart.domain).toEqual([0, 100])
    expect(chart.track).toEqual({ fill: CHART_NEUTRAL.surface })
  })

  test('the provider chart scale is the larger of 100 and the top rate, and its colors wrap the eight-color palette', () => {
    const report = fullReport()
    report.citationScorecard.providerRates = Array.from({ length: 9 }, (_, index) => ({
      provider: `p${index + 1}`,
      citedCount: index,
      mentionedCount: 0,
      totalCount: 8,
      citationRate: index === 8 ? 120 : index * 10,
      mentionRate: 0,
    }))
    renderReportPage(report, { audience: 'agency' })
    const chart = barChart(getReportSection(ReportSectionIds['citation-scorecard']), 'Provider citation rate')
    expect(chart.domain).toEqual([0, 120])
    expect(chart.rows.map(row => row.color)).toEqual([...CHART_SERIES_COLORS, CHART_SERIES_COLORS[0]])
    expect(chart.rows[8]).toEqual({ label: 'p9', value: 120, color: CHART_SERIES_COLORS[0], valueLabel: '120% (8/8)' })
  })

  test.each<[string, (report: ProjectReportDto) => void]>([
    ['no queries', (report) => { report.citationScorecard.queries = []; report.citationScorecard.matrix = [] }],
    ['no providers', (report) => { report.citationScorecard.providers = [] }],
  ])('with %s, the chart stays and the empty state replaces only the legend and the matrix', (_name, mutate) => {
    const report = fullReport()
    mutate(report)
    expect(agencyOutlineSection(report, ReportSectionIds['citation-scorecard'])).toEqual({
      id: 'citation-scorecard',
      eyebrow: 'Section 3',
      title: 'Citation Scorecard',
      intro: 'Per-engine citation and mention coverage from the latest check.',
      items: [{ heading: 'Provider citation rate' }, { empty: 'Run a check to populate the citation matrix.' }],
      content: [{ text: 'Provider citation rate' }, { text: 'Run a check to populate the citation matrix.' }],
    })
  })
})

describe('competitor landscape', () => {
  test('each competitor row reads its pressure, citations, class-scoped mentions, citation share and cited queries', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const table = sectionTable(getReportSection(ReportSectionIds['competitor-landscape']), 'Domain')
    expect(headerTexts(table)).toEqual(LANDSCAPE_HEADERS)
    const [rival, other] = bodyRows(table)
    expect(cellTexts(rival!).slice(0, 5)).toEqual(['rival.com', 'High', '3 / 4', '2 / 4', '0%'])
    expect(cellTexts(other!)).toEqual(['other.com', 'Low', '1 / 4', '1 / 4', '0%', 'answer engine'])
    expect(within(rival!).getByText('High').className).toContain('text-negative')
    expect(within(other!).getByText('Low').className).toContain('text-positive')
    expect(other!.querySelector('details')).toBeNull()
  })

  test("a competitor no answer mentioned reads 0 over the landscape's answer total", () => {
    const report = fullReport()
    report.mentionLandscape.totalAnswerSnapshots = 5
    report.competitorLandscape.competitors.push({
      domain: 'quiet.com', citationCount: 1, totalCount: 4, pressureLabel: 'Moderate', citedQueries: [], sharePct: 12.5, theirCitedPages: [],
    })
    renderReportPage(report, { audience: 'agency' })
    const table = sectionTable(getReportSection(ReportSectionIds['competitor-landscape']), 'Domain')
    const quiet = bodyRows(table)[2]!
    expect(cellTexts(quiet)).toEqual(['quiet.com', 'Moderate', '1 / 4', '0 / 5', '12.5%', ''])
    expect(within(quiet).getByText('Moderate').className).toContain('text-caution')
  })

  test('cited queries list the first five and mark the rest with …', () => {
    const report = fullReport()
    report.competitorLandscape.competitors[1]!.citedQueries = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']
    renderReportPage(report, { audience: 'agency' })
    const table = sectionTable(getReportSection(ReportSectionIds['competitor-landscape']), 'Domain')
    expect(cellTexts(bodyRows(table)[1]!)[5]).toBe('q1, q2, q3, q4, q5…')
  })

  test('cited URLs open from a disclosure, each link in a new tab with the queries it was cited for', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const table = sectionTable(getReportSection(ReportSectionIds['competitor-landscape']), 'Domain')
    const disclosure = bodyRows(table)[0]!.querySelector('details')!
    expect(normalizeOutlineText(disclosure.querySelector('summary')?.textContent)).toBe('1 cited URL')
    const links = Array.from(disclosure.querySelectorAll('a'))
    expect(links.map(link => [link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel'), link.textContent])).toEqual([
      ['https://rival.com/best-aeo', '_blank', 'noopener noreferrer', 'https://rival.com/best-aeo'],
    ])
    expect(normalizeOutlineText(disclosure.querySelector('li')?.textContent)).toBe('https://rival.com/best-aeo aeo platform, answer engine')
  })

  test('an unsafe cited URL keeps its text but its link collapses to #', () => {
    const report = fullReport()
    report.competitorLandscape.competitors[0]!.theirCitedPages = [
      { url: 'javascript:alert(1)', citedFor: ['x'] },
      { url: 'data:text/html,<script>alert(2)</script>', citedFor: ['x'] },
      { url: 'https://benign.example/post', citedFor: ['x'] },
    ]
    renderReportPage(report, { audience: 'agency' })
    const table = sectionTable(getReportSection(ReportSectionIds['competitor-landscape']), 'Domain')
    const disclosure = bodyRows(table)[0]!.querySelector('details')!
    expect(normalizeOutlineText(disclosure.querySelector('summary')?.textContent)).toBe('3 cited URLs')
    expect(Array.from(disclosure.querySelectorAll('a'), link => [link.getAttribute('href'), link.textContent])).toEqual([
      ['#', 'javascript:alert(1)'],
      ['#', 'data:text/html,<script>alert(2)</script>'],
      ['https://benign.example/post', 'https://benign.example/post'],
    ])
  })

  test("the mentions and citation share headers keep the HTML report's header notes as tooltips", () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['competitor-landscape'])
    const citationShare = within(section).getByRole('button', {
      name: 'Citation share — % of cited-source slots that went to this competitor across tracked queries. Distinct from Mention Share.',
    })
    const mentions = within(section).getByRole('button', {
      name: 'Mentions on non-brand queries. Branded queries are counted separately — the client is named on nearly all of them and a competitor cannot be, so pooling the two would rank the client on its own brand recall.',
    })
    expect(normalizeOutlineText(citationShare.closest('th')?.textContent)).toBe('Citation share')
    expect(normalizeOutlineText(mentions.closest('th')?.textContent)).toBe('Mentions (non-brand queries)')
  })

  test('a pooled basket labels the mention header, chart and tooltip as pooled, and never as non-brand', () => {
    const report = fullReport()
    report.mentionLandscape.scope = 'pooled'
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['competitor-landscape'])
    expect(headerTexts(sectionTable(section, 'Domain'))[3]).toBe('Mentions (pooled queries · classification unavailable)')
    expect(barChart(section, 'Mentions per domain · pooled queries · classification unavailable').rows).toHaveLength(3)
    expect(within(section).getByRole('button', { name: /all tracked queries remain pooled/ })).toBeTruthy()
    expect(within(section).queryByRole('button', { name: /Branded queries are counted separately/ })).toBeNull()
    expect(section.textContent).not.toContain('non-brand queries')
  })

  test('the citation and mention charts lead with the project bar in the accent color, then one bar per competitor', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['competitor-landscape'])
    const citations = barChart(section, 'Citations per domain')
    expect(citations.rows).toEqual([
      { label: 'rich.example.com', value: 4, color: CHART_SERIES_COLORS[1], valueLabel: '4' },
      { label: 'rival.com', value: 3, color: CHART_SERIES_COLORS[2], valueLabel: '3' },
      { label: 'other.com', value: 1, color: CHART_SERIES_COLORS[3], valueLabel: '1' },
    ])
    expect(citations.domain).toEqual([0, 4])
    expect(citations.track).toBe(false)
    const mentions = barChart(section, 'Mentions per domain · non-brand queries')
    expect(mentions.rows).toEqual([
      { label: 'rich.example.com', value: 3, color: CHART_SERIES_COLORS[1], valueLabel: '3' },
      { label: 'rival.com', value: 2, color: CHART_SERIES_COLORS[2], valueLabel: '2' },
      { label: 'other.com', value: 1, color: CHART_SERIES_COLORS[3], valueLabel: '1' },
    ])
    expect(mentions.domain).toEqual([0, 3])
    // Branded recall is its own chart with its own counts, never added into the competitive one.
    const branded = barChart(section, 'Mentions per domain · branded queries')
    expect(branded.rows).toEqual([
      { label: 'rich.example.com', value: 2, color: CHART_SERIES_COLORS[1], valueLabel: '2' },
      { label: 'rival.com', value: 0, color: CHART_SERIES_COLORS[2], valueLabel: '0' },
      { label: 'other.com', value: 0, color: CHART_SERIES_COLORS[3], valueLabel: '0' },
    ])
    expect(branded.domain).toEqual([0, 2])
  })

  test('without competitors, the one-bar citation chart is left out and the table gives way to its empty state', () => {
    const report = fullReport()
    report.competitorLandscape.competitors = []
    expect(agencyOutlineSection(report, ReportSectionIds['competitor-landscape'])).toEqual({
      id: 'competitor-landscape',
      eyebrow: 'Section 4',
      title: 'Competitor Landscape',
      intro: 'Who AI engines cite and mention instead of the client.',
      items: [
        { heading: 'Mentions per domain · non-brand queries' },
        { empty: 'No competitors configured.' },
        { note: BRANDED_NOTE },
        { heading: 'Mentions per domain · branded queries' },
      ],
      content: [
        { text: 'Mentions per domain · non-brand queries' },
        { text: 'No competitors configured.' },
        { text: BRANDED_NOTE },
        { text: 'Mentions per domain · branded queries' },
      ],
    })
  })

  test('branded answers alone keep the landscape out of its no-data state', () => {
    const report = emptyReport()
    report.mentionLandscape.branded = { projectMentionCount: 3, totalAnswerSnapshots: 3, competitors: [] }
    expect(agencyOutlineSection(report, ReportSectionIds['competitor-landscape'])).toEqual({
      id: 'competitor-landscape',
      eyebrow: 'Section 4',
      title: 'Competitor Landscape',
      intro: 'Who AI engines cite and mention instead of the client.',
      items: [{ empty: 'No competitors configured.' }],
      content: [{ text: 'No competitors configured.' }],
    })
  })

  test.each<[string, (report: ProjectReportDto) => void]>([
    ['no branded answers', (report) => { report.mentionLandscape.branded = { projectMentionCount: 0, totalAnswerSnapshots: 0, competitors: [] } }],
    ['branded answers but no competitor to chart against', (report) => { report.mentionLandscape.branded.competitors = [] }],
    ['a payload from a server without the branded split', (report) => { delete (report.mentionLandscape as Partial<MentionLandscape>).branded }],
  ])('with %s, the branded note and chart are left out', (_name, mutate) => {
    const report = fullReport()
    mutate(report)
    expect(agencyOutlineSection(report, ReportSectionIds['competitor-landscape'])?.items).toEqual([
      { heading: 'Citations per domain' },
      { heading: 'Mentions per domain · non-brand queries' },
      { table: LANDSCAPE_HEADERS },
    ])
    expect(within(getReportSection(ReportSectionIds['competitor-landscape'])).queryByRole('img', { name: 'Mentions per domain · branded queries bar chart' })).toBeNull()
  })

  test('when no tracked brand was named, a note before the charts says mention share is unavailable', () => {
    const report = fullReport()
    withNoBrandNamed(report)
    renderReportPage(report, { audience: 'agency' })
    const items = reportOutlineSection(readReportOutline(document.body), ReportSectionIds['competitor-landscape'])?.items
    expect(items?.slice(0, 3)).toEqual([
      { note: 'Mention share unavailable for non-brand queries: no tracked brand was named, so the denominator is 0.' },
      { heading: 'Citations per domain' },
      { heading: 'Mentions per domain · non-brand queries' },
    ])
    const mentions = barChart(getReportSection(ReportSectionIds['competitor-landscape']), 'Mentions per domain · non-brand queries')
    expect(mentions.rows.map(row => row.value)).toEqual([0, 0, 0])
    expect(mentions.domain).toEqual([0, 1])
  })

  test.each<[string, (report: ProjectReportDto) => void]>([
    ['a share of voice that explains itself', (report) => {
      report.mentionLandscape.nonBrand.shareOfVoice = {
        basis: 'observed', availability: 'not-measured', reason: 'insufficient-observed', queryClass: 'non-brand',
        percent: null, projectMentions: 0, competitorMentions: 6, competitorCount: 2, snapshotsWithAnswerText: 3, perCompetitor: [],
      }
    }],
    ['a competitor mention share still measured', (report) => { report.mentionLandscape.competitors[0]!.sharePct = 0 }],
  ])('with %s, no unavailable note is added', (_name, mutate) => {
    const report = fullReport()
    withNoBrandNamed(report)
    mutate(report)
    const items = agencyOutlineSection(report, ReportSectionIds['competitor-landscape'])?.items ?? []
    expect(items.filter(item => 'note' in item)).toEqual([{ note: BRANDED_NOTE }])
  })
})

describe('AI citation sources', () => {
  test('the headline emphasizes the tracked-competitor share, and only a competitor bucket brings it', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    expect(within(getReportSection(ReportSectionIds['ai-source-origin'])).getByText('20%').tagName).toBe('STRONG')
    cleanupReportPage()
    expect(agencyOutlineSection(richReport(), ReportSectionIds['ai-source-origin'])?.items).toEqual([
      { heading: 'Top sources' },
      { table: ['Domain', 'Citations', 'Tag'] },
      { heading: 'By source type' },
    ])
  })

  test('top sources tag a tracked competitor apart from an external domain', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const table = sectionTable(getReportSection(ReportSectionIds['ai-source-origin']), 'Domain')
    expect(bodyRows(table).map(cellTexts)).toEqual([
      ['reddit.com', '4', 'External'],
      ['rival.com', '2', 'Tracked competitor'],
    ])
    expect(within(table).getByText('Tracked competitor').className).toContain('text-negative')
    expect(within(table).getByText('External').className).toContain('text-neutral')
  })

  test('source type bars are sized against the largest bucket and colored by what the source is', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['ai-source-origin'])
    const bars = Array.from(section.querySelectorAll<HTMLElement>('[data-share-bar]'))
    expect(bars.map(bar => bar.style.width)).toEqual(['100%', '60%', '40%'])
    expect(bars.map(bar => bar.style.background)).toEqual([CHART_TONE.caution, CHART_SERIES_COLORS[1], CHART_TONE.negative])
    for (const [label, value] of [['Forums & Q&A', '5 (50%)'], ['News & Media', '3 (30%)'], ['Tracked competitors', '2 (20%)']] as const) {
      expect(within(section).getByText(label)).toBeTruthy()
      expect(within(section).getByText(value)).toBeTruthy()
    }
  })

  test('an empty competitor bucket still heads the section, while the table and the zero-total bars are left out', () => {
    const report = fullReport()
    report.aiSourceOrigin = { categories: [{ category: 'competitor', label: 'Tracked competitors', count: 0, sharePct: 0 }], topDomains: [] }
    expect(agencyOutlineSection(report, ReportSectionIds['ai-source-origin'])).toEqual({
      id: 'ai-source-origin',
      eyebrow: 'Section 5',
      title: 'AI Citation Sources',
      intro: 'External domains AI engines cited most in the latest check.',
      items: [{ note: '0% of citations went to tracked competitors (0 of 0).' }],
      content: [{ text: '0% of citations went to tracked competitors (0 of 0).' }],
    })
  })
})
