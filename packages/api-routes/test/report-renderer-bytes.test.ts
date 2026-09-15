import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ProjectReportDto, ReportAudience } from '@ainyc/canonry-contracts'
import {
  advancedReport,
  emptyReport,
  fullReport,
  reportWithChangeHistory,
  richReport,
  simpleVisibility,
} from '../../contracts/test/fixtures/report-dto.js'
import { renderReportHtml } from '../src/report-renderer.js'
import { reportHtmlOutline, reportHtmlSectionIds } from './report-outline.js'

/**
 * Pins the downloadable report byte for byte, and the outline both report
 * renderers must share.
 *
 * - `__snapshots__/report-html/<audience>.<fixture>.html`: the whole document.
 *   Moving copy into a shared module, or any other refactor, must leave these
 *   files untouched. Never update them to make a test pass; a diff here is a
 *   change to what clients and agencies download.
 * - `fixtures/report-outline/<audience>.<fixture>.json`: the section outline the
 *   SPA suite compares its DOM against (see `report-outline.ts`).
 *
 * `formatDate` renders an ISO timestamp in the process timezone, so every
 * render here runs in UTC. Without the pin the trend dates at UTC midnight
 * would read a day earlier on a machine west of Greenwich than in CI.
 */

const FIXTURES = {
  empty: emptyReport,
  rich: richReport,
  'change-history': reportWithChangeHistory,
  full: fullReport,
  advanced: advancedReport,
} as const satisfies Record<string, () => ProjectReportDto>

const OUTLINE_FIXTURES = ['empty', 'full', 'advanced'] as const
const AUDIENCES = ['client', 'agency'] as const satisfies readonly ReportAudience[]

let originalTimeZone: string | undefined

beforeAll(() => {
  originalTimeZone = process.env.TZ
  process.env.TZ = 'UTC'
})

afterAll(() => {
  if (originalTimeZone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimeZone
})

describe.each(AUDIENCES)('%s report HTML', (audience) => {
  test.each(Object.keys(FIXTURES) as Array<keyof typeof FIXTURES>)('%s fixture renders byte for byte', async (fixture) => {
    const html = renderReportHtml(FIXTURES[fixture](), { audience })
    await expect(html).toMatchFileSnapshot(`./__snapshots__/report-html/${audience}.${fixture}.html`)
  })

  test.each(OUTLINE_FIXTURES)('%s fixture outline golden', async (fixture) => {
    const outline = reportHtmlOutline(renderReportHtml(FIXTURES[fixture](), { audience }))
    await expect(`${JSON.stringify(outline, null, 2)}\n`).toMatchFileSnapshot(`./fixtures/report-outline/${audience}.${fixture}.json`)
  })
})

test('the render timezone is pinned, so dated cells match CI on any machine', () => {
  const html = renderReportHtml(reportWithChangeHistory(), { audience: 'agency' })
  const trend = html.split('id="citations-trend"')[1]?.split('</section>')[0] ?? ''
  // The trend points are stamped at UTC midnight on 2026-04-01..04.
  expect(trend).toContain('<td>Apr 1, 2026</td>')
  expect(trend).not.toContain('Mar 31, 2026')
})

type ServerActivityState = 'connected' | 'no-data' | 'not-connected'

interface ReportVariant {
  visibility?: 'simple' | 'advanced'
  serverActivity?: ServerActivityState
  opportunities?: boolean
  gaps?: boolean
}

/** richReport() reshaped along the four axes the section order branches on. */
function variant({ visibility, serverActivity = 'connected', opportunities = true, gaps = true }: ReportVariant): ProjectReportDto {
  const report = visibility === 'advanced' ? advancedReport() : richReport()
  if (visibility === 'simple') report.visibility = simpleVisibility()
  if (serverActivity === 'not-connected') report.serverActivity = null
  if (serverActivity === 'no-data') report.serverActivity = { ...report.serverActivity!, hasData: false }
  if (!opportunities) report.contentOpportunities = []
  if (!gaps) report.contentGaps = []
  return report
}

const CLIENT_ORDER = ['client-summary', 'whats-changed', 'server-activity', 'client-action-plan', 'client-evidence-summary']
const AGENCY_ORDER = [
  'executive-summary', 'whats-changed', 'agency-action-plan', 'agency-diagnostics', 'citation-scorecard',
  'competitor-landscape', 'ai-source-origin', 'gsc', 'ga', 'social-referrals', 'ai-referrals', 'server-activity',
  'indexing-health', 'citations-trend', 'insights', 'content-opportunities', 'content-gaps', 'recommended-next-steps',
]
const without = (order: readonly string[], ...ids: string[]) => order.filter(id => !ids.includes(id))

const ORDER_CASES: Array<{ name: string; audience: ReportAudience; build: () => ProjectReportDto; expected: string[] }> = [
  { name: 'client, legacy, source connected', audience: 'client', build: () => variant({}), expected: CLIENT_ORDER },
  { name: 'client, legacy, source connected with no data', audience: 'client', build: () => variant({ serverActivity: 'no-data' }), expected: CLIENT_ORDER },
  { name: 'client, legacy, no source', audience: 'client', build: () => variant({ serverActivity: 'not-connected' }), expected: without(CLIENT_ORDER, 'server-activity') },
  { name: 'client, empty report', audience: 'client', build: emptyReport, expected: without(CLIENT_ORDER, 'server-activity') },
  { name: 'client, simple visibility', audience: 'client', build: () => variant({ visibility: 'simple' }), expected: without(CLIENT_ORDER, 'whats-changed') },
  { name: 'client, advanced visibility', audience: 'client', build: () => variant({ visibility: 'advanced' }), expected: without(CLIENT_ORDER, 'whats-changed') },
  { name: 'client, advanced visibility, no source', audience: 'client', build: () => variant({ visibility: 'advanced', serverActivity: 'not-connected' }), expected: ['client-summary', 'client-action-plan', 'client-evidence-summary'] },
  { name: 'client, no opportunities or gaps', audience: 'client', build: () => variant({ opportunities: false, gaps: false }), expected: CLIENT_ORDER },
  { name: 'agency, legacy, source connected', audience: 'agency', build: () => variant({}), expected: AGENCY_ORDER },
  { name: 'agency, legacy, source connected with no data', audience: 'agency', build: () => variant({ serverActivity: 'no-data' }), expected: AGENCY_ORDER },
  { name: 'agency, legacy, no source keeps the connect prompt', audience: 'agency', build: () => variant({ serverActivity: 'not-connected' }), expected: AGENCY_ORDER },
  { name: 'agency, empty report', audience: 'agency', build: emptyReport, expected: without(AGENCY_ORDER, 'content-opportunities', 'content-gaps') },
  { name: 'agency, no opportunities', audience: 'agency', build: () => variant({ opportunities: false }), expected: without(AGENCY_ORDER, 'content-opportunities') },
  { name: 'agency, no gaps', audience: 'agency', build: () => variant({ gaps: false }), expected: without(AGENCY_ORDER, 'content-gaps') },
  {
    name: 'agency, simple visibility', audience: 'agency', build: () => variant({ visibility: 'simple' }),
    expected: ['client-summary', ...without(AGENCY_ORDER, 'executive-summary', 'whats-changed')],
  },
  {
    name: 'agency, advanced visibility', audience: 'agency', build: () => variant({ visibility: 'advanced' }),
    expected: [
      'client-summary', 'agency-action-plan', 'ai-source-origin', 'gsc', 'ga', 'social-referrals', 'ai-referrals',
      'server-activity', 'indexing-health', 'insights', 'content-opportunities', 'content-gaps', 'recommended-next-steps',
    ],
  },
]

test.each(ORDER_CASES)('section order: $name', ({ audience, build, expected }) => {
  expect(reportHtmlSectionIds(renderReportHtml(build(), { audience }))).toEqual(expected)
})

describe('reportHtmlOutline', () => {
  test('reads the section scaffold apart from its body, in document order', () => {
    const html = `<section class="report-section" id="demo">
      <div class="eyebrow">Section 9</div>
      <h2>Demo &amp; Co</h2>
      <p class="section-intro">What   this
        section is.</p>
      <div class="metric-grid"><div class="metric"><div class="label">Total sessions</div><div class="value">12</div></div></div>
      <div class="chart-card"><h3>Top pages</h3>
        <p class="meta">Pages people   landed on.</p>
        <div class="table-scroll"><table class="report-table"><thead><tr><th>Page</th><th class="numeric" title="hidden">Sessions</th></tr></thead><tbody><tr><td>/</td><td>12</td></tr></tbody></table></div>
      </div>
      <div class="chart-card"><h3>Wins</h3><p class="section-intro">No new gains.</p></div>
      <p class="source-origin-headline"><strong>20%</strong> of citations went elsewhere.</p>
      <div class="empty-state">Nothing yet.</div>
    </section>
    <div class="chart-note"><p>Share of voice between sections</p></div>`
    expect(reportHtmlOutline(html)).toEqual({ sections: [{
      id: 'demo',
      eyebrow: 'Section 9',
      title: 'Demo & Co',
      intro: 'What this section is.',
      items: [
        { tile: 'Total sessions' },
        { heading: 'Top pages' },
        { note: 'Pages people landed on.' },
        { table: ['Page', 'Sessions'] },
        { heading: 'Wins' },
        { note: 'No new gains.' },
        { note: '20% of citations went elsewhere.' },
        { empty: 'Nothing yet.' },
      ],
    }] })
    expect(reportHtmlSectionIds(html)).toEqual(['demo'])
  })

  test('a section with no scaffold keeps null eyebrow, title and intro, and a legend after the intro stays a note', () => {
    const html = `<section id="bare"><div class="client-hero"><div class="client-hero-eyebrow">Overview</div></div>
      <div class="client-metric-grid"><div class="client-metric-tile"><div class="label">AI tools tested</div></div></div></section>
      <section id="legend"><div class="eyebrow">Section 3</div><h2>Scorecard</h2><p class="section-intro">Intro.</p><p class="section-intro">Legend: C = cited.</p></section>`
    expect(reportHtmlOutline(html).sections).toEqual([
      { id: 'bare', eyebrow: null, title: null, intro: null, items: [{ tile: 'AI tools tested' }] },
      { id: 'legend', eyebrow: 'Section 3', title: 'Scorecard', intro: 'Intro.', items: [{ note: 'Legend: C = cited.' }] },
    ])
  })
})
