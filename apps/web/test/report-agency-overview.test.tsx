/**
 * Report slice S1, the agency overview: the executive summary with its market
 * scope, the technical diagnostics, and the recommended next steps.
 *
 * Each section is held to the HTML report's committed outline golden, and to
 * the values the HTML report prints for the same fixture. Static copy is read
 * from REPORT_SECTION_COPY; sentences built from report data are written out,
 * so a wrong number or fragment fails here and not only in contracts.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { within } from '@testing-library/react'
import { REPORT_SECTION_COPY, ReportSectionIds, type ProjectReportDto, type ReportSectionId } from '@ainyc/canonry-contracts'
import { advancedReport, emptyReport, fullReport, richReport } from '../../../packages/contracts/test/fixtures/report-dto.js'
import { cleanupReportPage, getReportSection, queryReportSection, renderReportPage } from './report-page-harness.js'
import {
  normalizeOutlineText,
  readReportOutline,
  reportOutlineGolden,
  reportOutlineSection,
  type ReportOutlineFixture,
} from './report-outline.js'

vi.mock('recharts', () => import('./report-recharts-stub.js'))

afterEach(cleanupReportPage)

const OVERVIEW_SECTION_IDS: readonly ReportSectionId[] = [
  ReportSectionIds['executive-summary'],
  ReportSectionIds['agency-diagnostics'],
  ReportSectionIds['recommended-next-steps'],
]

const executiveCopy = REPORT_SECTION_COPY['executive-summary']
const scopeCopy = executiveCopy.marketScope

interface TileRead {
  value: string
  subtitle: string | null
  valueElement: HTMLElement
  subtitleElement: HTMLElement | null
}

/** A tile's value and the line under it, found by the tile's label. */
function readTile(root: HTMLElement, label: string): TileRead {
  const labelElement = Array.from(root.querySelectorAll<HTMLElement>('[data-report-tile]'))
    .find(element => normalizeOutlineText(element.textContent) === label)
  const [valueElement, subtitleElement] = Array.from(labelElement?.parentElement?.children ?? []).slice(1) as Array<HTMLElement | undefined>
  if (!valueElement) throw new Error(`No tile labelled "${label}"`)
  return {
    value: normalizeOutlineText(valueElement.textContent),
    subtitle: subtitleElement ? normalizeOutlineText(subtitleElement.textContent) : null,
    valueElement,
    subtitleElement: subtitleElement ?? null,
  }
}

function tileLabels(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('[data-report-tile]'), element => normalizeOutlineText(element.textContent))
}

function notes(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('[data-report-note]'), element => normalizeOutlineText(element.textContent))
}

/** The tone-accented card a finding or diagnostic title sits in. */
function insightCard(titleElement: HTMLElement): HTMLElement {
  const card = titleElement.closest<HTMLElement>('.insight-card')
  if (!card) throw new Error(`"${titleElement.textContent}" is not inside an insight card`)
  return card
}

function toneClasses(card: HTMLElement): string[] {
  return Array.from(card.classList).filter(name => name.startsWith('insight-card-'))
}

function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

describe('parity with the HTML report outline', () => {
  const cases: Array<[ReportOutlineFixture, () => ProjectReportDto, readonly ReportSectionId[]]> = [
    ['empty', emptyReport, OVERVIEW_SECTION_IDS],
    ['full', fullReport, OVERVIEW_SECTION_IDS],
    // An Advanced selection drops the executive summary and the diagnostics; next steps stay.
    ['advanced', advancedReport, [ReportSectionIds['recommended-next-steps']]],
  ]

  test.each(cases)('the agency overview sections of the %s report match the HTML outline', (name, build, present) => {
    renderReportPage(build(), { audience: 'agency' })
    const outline = readReportOutline(document.body)
    const golden = reportOutlineGolden('agency', name)
    for (const id of OVERVIEW_SECTION_IDS) {
      const expected = reportOutlineSection(golden, id)
      expect(expected !== undefined, `the ${name} golden has ${id}`).toBe(present.includes(id))
      expect(reportOutlineSection(outline, id), id).toEqual(expected)
    }
  })

  test('the client audience renders none of the agency overview sections', () => {
    renderReportPage(fullReport())
    for (const id of OVERVIEW_SECTION_IDS) expect(queryReportSection(id), id).toBeNull()
  })
})

describe('executive summary', () => {
  test('the hero names the cited queries and both coverage signals', () => {
    renderReportPage(richReport(), { audience: 'agency' })
    const section = within(getReportSection(ReportSectionIds['executive-summary']))
    expect(section.getByText(executiveCopy.heroKicker)).toBeTruthy()
    expect(section.getByText('3 of 5 tracked queries cite Rich Project')).toBeTruthy()
    expect(section.getByText('65% citation coverage and 40% mention coverage across 2 providers.')).toBeTruthy()
  })

  test('proof tiles come first, then the metric tiles, each with the HTML value and line', () => {
    renderReportPage(richReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['executive-summary'])
    expect(tileLabels(section)).toEqual([
      executiveCopy.proofTiles.citationTrend,
      executiveCopy.proofTiles.mentionCoverage,
      executiveCopy.proofTiles.prioritizedActions,
      executiveCopy.tiles.citationRate,
      executiveCopy.tiles.mentionRate,
      executiveCopy.tiles.queriesTracked,
      executiveCopy.tiles.gscClicks,
      executiveCopy.tiles.gaSessions,
      scopeCopy.currentLabel,
      scopeCopy.notIncludedLabel,
      scopeCopy.providerLabel,
    ])
    expect(readTile(section, executiveCopy.proofTiles.citationTrend)).toMatchObject({ value: '↑ Up', subtitle: '3/5 queries cited' })
    expect(readTile(section, executiveCopy.proofTiles.mentionCoverage)).toMatchObject({ value: '40%', subtitle: '2/5 queries mentioned' })
    expect(readTile(section, executiveCopy.proofTiles.prioritizedActions)).toMatchObject({ value: '2', subtitle: executiveCopy.prioritizedActionsCopy })
    expect(readTile(section, executiveCopy.tiles.citationRate)).toMatchObject({ value: '65%', subtitle: '↑ Up · 3/5 queries cited · 2 providers' })
    expect(readTile(section, executiveCopy.tiles.mentionRate)).toMatchObject({ value: '40%', subtitle: '2/5 queries mentioned' })
    expect(readTile(section, executiveCopy.tiles.queriesTracked)).toMatchObject({ value: '5', subtitle: '3 competitors tracked' })
    expect(readTile(section, executiveCopy.tiles.gscClicks)).toMatchObject({ value: '1.0K', subtitle: '5.0K imp · 20.0% CTR · Apr 1, 2026 → Apr 30, 2026' })
    expect(readTile(section, executiveCopy.tiles.gaSessions)).toMatchObject({ value: '12.0K', subtitle: '9.0K users · Apr 1, 2026 → Apr 30, 2026' })
  })

  test.each([
    ['up', '↑ Up', 'positive'],
    ['down', '↓ Down', 'negative'],
  ] as const)('a %s citation trend colors the trend tile and the trend label on the citation rate tile', (trend, label, tone) => {
    const report = richReport()
    report.executiveSummary.trend = trend
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['executive-summary'])
    const toneClass = new RegExp(`\\btext-${tone}`)
    const proof = readTile(section, executiveCopy.proofTiles.citationTrend)
    expect(proof.value).toBe(label)
    expect(proof.valueElement.className).toMatch(toneClass)
    const rate = readTile(section, executiveCopy.tiles.citationRate)
    expect(within(rate.subtitleElement!).getByText(label).className).toMatch(toneClass)
  })

  test('a flat or unknown trend is not colored', () => {
    const report = richReport()
    report.executiveSummary.trend = 'flat'
    renderReportPage(report, { audience: 'agency' })
    const proof = readTile(getReportSection(ReportSectionIds['executive-summary']), executiveCopy.proofTiles.citationTrend)
    expect(proof.value).toBe('→ Flat')
    expect(proof.valueElement.className).not.toMatch(/\btext-(positive|negative)/)
  })

  test('before any check the hero says so, only the always-on tiles show, and there is no market scope card', () => {
    renderReportPage(emptyReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['executive-summary'])
    expect(within(section).getByText('No AI citation data yet')).toBeTruthy()
    expect(within(section).getByText('Run a check to populate the first citation and mention baseline.')).toBeTruthy()
    expect(tileLabels(section)).toEqual([
      executiveCopy.proofTiles.citationTrend,
      executiveCopy.proofTiles.mentionCoverage,
      executiveCopy.proofTiles.prioritizedActions,
      executiveCopy.tiles.citationRate,
      executiveCopy.tiles.mentionRate,
      executiveCopy.tiles.queriesTracked,
    ])
    expect(readTile(section, executiveCopy.proofTiles.citationTrend)).toMatchObject({ value: '—', subtitle: 'no queries' })
    expect(readTile(section, executiveCopy.tiles.citationRate)).toMatchObject({ value: '0%', subtitle: '— · no queries · 0 providers' })
    expect(within(section).queryByText(scopeCopy.heading)).toBeNull()
  })

  test('findings follow the tiles as tone-accented insight cards, and the market scope card comes last', () => {
    const report = richReport()
    report.executiveSummary.findings.push(
      { title: 'GSC demand gap', detail: 'Two tracked queries have no impressions.', tone: 'caution' },
      { title: 'Mention coverage holding', detail: 'No change since the prior check.', tone: 'neutral' },
    )
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['executive-summary'])
    const title = (text: string) => within(section).getByText(text)
    expect(title('Citation rate at 65%').tagName).toBe('STRONG')
    expect(within(insightCard(title('Citation rate at 65%'))).getByText('Up from previous run.')).toBeTruthy()
    expect(toneClasses(insightCard(title('Citation rate at 65%')))).toEqual(['insight-card-positive'])
    expect(toneClasses(insightCard(title('1 critical regression')))).toEqual(['insight-card-negative'])
    expect(toneClasses(insightCard(title('GSC demand gap')))).toEqual(['insight-card-caution'])
    // Neutral keeps the base card's accent.
    expect(toneClasses(insightCard(title('Mention coverage holding')))).toEqual([])

    const lastMetricTile = readTile(section, executiveCopy.tiles.gaSessions).valueElement
    const firstFinding = insightCard(title('Citation rate at 65%'))
    const scopeHeading = within(section).getByRole('heading', { level: 3, name: scopeCopy.heading })
    expect(follows(lastMetricTile, firstFinding)).toBe(true)
    expect(follows(firstFinding, scopeHeading)).toBe(true)
  })

  test('market scope names the checked market, the markets left out, and the provider context', () => {
    renderReportPage(richReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['executive-summary'])
    expect(within(section).getByRole('heading', { level: 3, name: scopeCopy.heading })).toBeTruthy()
    expect(readTile(section, scopeCopy.currentLabel)).toMatchObject({ value: 'michigan (Detroit, Michigan, US)', subtitle: scopeCopy.currentCopy })
    expect(readTile(section, scopeCopy.notIncludedLabel)).toMatchObject({
      value: 'florida',
      subtitle: '1 configured market still needs a matching check before cross-market recommendations.',
    })
    expect(readTile(section, scopeCopy.providerLabel)).toMatchObject({ value: '2', subtitle: '2 providers received the market context.' })
    expect(notes(section)).toEqual([])
  })

  test.each([
    ['browser-geo', fullReport, 'cdp:chatgpt', '3'],
    ['ignored', () => {
      const report = richReport()
      report.meta.providerLocationHandling[0]!.treatment = 'ignored'
      return report
    }, 'gemini', '2'],
  ] as const)('a provider with %s market handling raises the review warning', (_treatment, build, provider, providerCount) => {
    renderReportPage(build(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['executive-summary'])
    expect(readTile(section, scopeCopy.providerLabel)).toMatchObject({ value: providerCount, subtitle: '1 provider need a closer location check.' })
    expect(notes(section)).toEqual([
      `Location handling needs review ${provider} used weak or indirect market handling. Treat provider-level differences cautiously.`,
    ])
    expect(within(section).getByText(scopeCopy.warningTitle).tagName).toBe('STRONG')
  })

  test('provider location data without a market still shows the card, naming no market', () => {
    const report = emptyReport()
    report.meta.providerLocationHandling = [{ provider: 'gemini', treatment: 'prompt', description: 'Location appended to the prompt.' }]
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['executive-summary'])
    expect(readTile(section, scopeCopy.currentLabel).value).toBe('No market set')
    expect(readTile(section, scopeCopy.notIncludedLabel)).toMatchObject({
      value: 'None',
      subtitle: 'No geographic hint was attached to this check; read findings as default-market or national results.',
    })
    expect(readTile(section, scopeCopy.providerLabel)).toMatchObject({ value: '1', subtitle: '1 provider received the market context.' })
  })
})

describe('technical diagnostics', () => {
  test('each diagnostic is a tone card with its detail and up to three proof chips, and the location caveat stays hidden', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['agency-diagnostics'])
    const headings = within(section).getAllByRole('heading', { level: 3 })
    expect(headings.map(heading => heading.textContent)).toEqual(['Provider citation coverage', 'Search demand mismatch'])
    expect(within(section).queryByText(REPORT_SECTION_COPY['agency-diagnostics'].hiddenTitle)).toBeNull()
    expect(within(section).queryByText('This report is scoped to the latest run location.')).toBeNull()

    const coverage = insightCard(headings[0]!)
    expect(toneClasses(coverage)).toEqual(['insight-card-negative'])
    expect(within(coverage).getByText('One provider returned zero client citations.')).toBeTruthy()
    expect(within(coverage).getByText('openai: 0/2')).toBeTruthy()

    const mismatch = insightCard(headings[1]!)
    expect(toneClasses(mismatch)).toEqual(['insight-card-caution'])
    expect(within(mismatch).getByText('Two tracked queries have no Search Console impressions.')).toBeTruthy()
    for (const chip of ['answer engine', 'aeo tools', 'aeo platform', '+1 more']) expect(within(mismatch).getByText(chip)).toBeTruthy()
    expect(within(mismatch).queryByText('best aeo')).toBeNull()
  })

  test('with nothing to flag the section keeps its intro and shows the HTML empty state', () => {
    renderReportPage(emptyReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['agency-diagnostics'])
    expect(section.querySelector('[data-report-intro]')?.textContent).toBe('Fast-read operator flags behind the action plan.')
    expect(within(section).getByText('No agency diagnostics available yet.')).toBeTruthy()
  })

  test('a report whose only diagnostic is the hidden location caveat shows the empty state', () => {
    const report = richReport()
    report.agencyDiagnostics.diagnostics = [
      { title: 'Location caveat', detail: 'This report is scoped to the latest run location.', severity: 'caution', evidence: [] },
    ]
    renderReportPage(report, { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['agency-diagnostics'])
    expect(within(section).queryByRole('heading', { level: 3 })).toBeNull()
    expect(within(section).getByText('No agency diagnostics available yet.')).toBeTruthy()
  })
})

describe('recommended next steps', () => {
  test('steps are an ordered list of the raw horizon, the title, and the rationale', () => {
    renderReportPage(fullReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['recommended-next-steps'])
    const list = within(section).getByRole('list')
    expect(list.tagName).toBe('OL')
    const steps = within(list).getAllByRole('listitem')
    expect(steps).toHaveLength(2)
    const [first, second] = steps as [HTMLElement, HTMLElement]
    expect(within(first).getByText('immediate')).toBeTruthy()
    expect(within(first).getByText('Resolve 1 critical regression')).toBeTruthy()
    expect(within(first).getByText('Lost citation on aeo platform.')).toBeTruthy()
    expect(within(second).getByText('short-term')).toBeTruthy()
    expect(within(second).getByText('Refresh the answer engine optimization page')).toBeTruthy()
    expect(within(second).getByText('The existing page ranks weakly for a query competitors own.')).toBeTruthy()
    expect(within(section).queryByText('Short term')).toBeNull()
  })

  test('with no steps the intro stays and the HTML empty state shows', () => {
    renderReportPage(emptyReport(), { audience: 'agency' })
    const section = getReportSection(ReportSectionIds['recommended-next-steps'])
    expect(section.querySelector('[data-report-intro]')?.textContent).toBe('Action items bucketed by timing.')
    expect(within(section).getByText('No outstanding actions.')).toBeTruthy()
    expect(within(section).queryByRole('list')).toBeNull()
  })
})
