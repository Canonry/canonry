import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ReportSectionIds, reportSectionOrder, type ProjectReportDto, type ReportAudience } from '@ainyc/canonry-contracts'
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

  // A section whose content reads empty is guarded on its skeleton alone: its
  // numbers, cells and badges could differ between the two surfaces with every
  // parity test green. If a section legitimately renders nothing, say so here
  // with the reason rather than letting the golden go quiet.
  test('every section of the goldens carries content', () => {
    for (const fixture of OUTLINE_FIXTURES) {
      for (const section of reportHtmlOutline(renderReportHtml(FIXTURES[fixture](), { audience })).sections) {
        expect(section.content.length, `${audience}.${fixture} ${section.id}`).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * The reader degrading to plain text would still produce a full-looking golden
 * — every kind below would silently fold into `{ text }` runs and stop guarding
 * what it names. One fixture set proves each kind is still being read.
 */
test('the goldens carry every content kind the outline cannot see', () => {
  const entries = OUTLINE_FIXTURES
    .flatMap(fixture => reportHtmlOutline(renderReportHtml(FIXTURES[fixture](), { audience: 'agency' })).sections)
    .flatMap(section => section.content)
  expect(entries.some(entry => 'tile' in entry && /\d/.test(entry.tile)), 'a tile value').toBe(true)
  expect(entries.some(entry => 'row' in entry && entry.row.length > 1), 'a table body row').toBe(true)
  expect(entries.some(entry => 'item' in entry), 'a list or step row').toBe(true)
  expect(entries.some(entry => 'summary' in entry), 'a details summary').toBe(true)
  const text = JSON.stringify(entries)
  expect(text, 'a badge tone').toContain('«negative|')
  expect(text, 'a delta tone').toContain('«positive|')
  expect(text, 'a link target').toContain('«link https://')
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

ORDER_CASES.push({
  name: 'agency, opportunities that all collapse into the report market',
  audience: 'agency',
  build: () => {
    const report = richReport()
    const [first] = report.contentOpportunities
    report.contentOpportunities = [{ ...first!, query: 'michigan' }, { ...first!, targetRef: 'rich:create:in-michigan', query: 'in michigan' }]
    return report
  },
  expected: without(AGENCY_ORDER, 'content-opportunities'),
})

const withoutShareOfVoice = (order: readonly string[]) => order.filter(id => id !== ReportSectionIds['share-of-voice'])

test.each(ORDER_CASES)('section order: $name', ({ audience, build, expected }) => {
  const report = build()
  const htmlIds = reportHtmlSectionIds(renderReportHtml(report, { audience }))
  expect(htmlIds).toEqual(expected)
  // The shared order both renderers follow, minus share of voice (not a section in the HTML).
  expect(withoutShareOfVoice(reportSectionOrder(report, audience))).toEqual(htmlIds)
})

const ORDER_MATRIX = AUDIENCES.flatMap(audience =>
  ([undefined, 'simple', 'advanced'] as const).flatMap(visibility =>
    (['connected', 'no-data', 'not-connected'] as const).flatMap(serverActivity =>
      ([true, false] as const).flatMap(opportunities =>
        ([true, false] as const).map(gaps => ({
          audience,
          shape: { visibility, serverActivity, opportunities, gaps },
          label: `${audience}, visibility ${visibility ?? 'none'}, server ${serverActivity}, opportunities ${opportunities}, gaps ${gaps}`,
        }))))))

test.each(ORDER_MATRIX)('reportSectionOrder matches the HTML: $label', ({ audience, shape }) => {
  const report = variant(shape)
  expect(withoutShareOfVoice(reportSectionOrder(report, audience))).toEqual(reportHtmlSectionIds(renderReportHtml(report, { audience })))
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
    expect(reportHtmlOutline(html).sections[0]).toEqual({
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
      // The same section read for what it SAYS: the tile's value beside its
      // label, the table's body row cell by cell, and the runs of copy
      // between them.
      content: [
        { tile: 'Total sessions 12' },
        { text: 'Top pages' },
        { text: 'Pages people landed on.' },
        { row: ['/', '12'] },
        { text: 'Wins' },
        { text: 'No new gains.' },
        { text: '20% of citations went elsewhere.' },
        { text: 'Nothing yet.' },
      ],
    })
    expect(reportHtmlSectionIds(html)).toEqual(['demo'])
  })

  test('share-of-voice notes between sections are read as a band of their own', () => {
    const html = `<section id="one"><h2>One</h2><p class="chart-note">A note INSIDE a section stays there.</p></section>
      <div class="chart-note"><p>Share of voice · non-brand queries: 25.0%</p><p>No competitors configured.</p></div>
      <div class="chart-note"><p>Share of voice · branded queries: Not measured</p></div>
      <section id="two"><h2>Two</h2></section>`
    // One band, in document order, holding both query classes: the SPA wraps
    // the same paragraphs in a single [data-report-section="share-of-voice"].
    expect(reportHtmlOutline(html).sections.map(section => section.id)).toEqual(['one', 'share-of-voice', 'two'])
    expect(reportHtmlOutline(html).sections[1]).toEqual({
      id: 'share-of-voice',
      eyebrow: null,
      title: null,
      intro: null,
      items: [],
      content: [
        { text: 'Share of voice · non-brand queries: 25.0% No competitors configured. Share of voice · branded queries: Not measured' },
      ],
    })
    // Still not a <section>: the order assertions compare against these ids.
    expect(reportHtmlSectionIds(html)).toEqual(['one', 'two'])
    expect(reportHtmlOutline(html).sections[0]?.items).toEqual([{ note: 'A note INSIDE a section stays there.' }])
  })

  test('a section with no scaffold keeps null eyebrow, title and intro, and a legend after the intro stays a note', () => {
    const html = `<section id="bare"><div class="client-hero"><div class="client-hero-eyebrow">Overview</div></div>
      <div class="client-metric-grid"><div class="client-metric-tile"><div class="label">AI tools tested</div></div></div></section>
      <section id="legend"><div class="eyebrow">Section 3</div><h2>Scorecard</h2><p class="section-intro">Intro.</p><p class="section-intro">Legend: C = cited.</p></section>`
    expect(reportHtmlOutline(html).sections).toEqual([
      {
        id: 'bare',
        eyebrow: null,
        title: null,
        intro: null,
        items: [{ tile: 'AI tools tested' }],
        content: [{ text: 'Overview' }, { tile: 'AI tools tested' }],
      },
      {
        id: 'legend',
        eyebrow: 'Section 3',
        title: 'Scorecard',
        intro: 'Intro.',
        items: [{ note: 'Legend: C = cited.' }],
        content: [{ text: 'Legend: C = cited.' }],
      },
    ])
  })

  test('a badge is read with its tone, a delta with the tone of the value it moved, and neutral reads as no tone at all', () => {
    const html = `<section id="tones">
      <div class="metric"><div class="label">Mentions</div><div class="value tone-negative">40% <span>↓</span></div><div class="delta">-5.0% vs 45%</div></div>
      <table class="report-table"><thead><tr><th>Change</th><th>Query</th></tr></thead>
        <tbody><tr><td><span class="badge tone-negative">Critical</span></td><td>Lost citation <span class="badge tone-neutral">× 2</span></td></tr></tbody>
      </table>
      <div class="step"><span class="horizon">immediate</span><span class="title">Fix it</span><span class="rationale">Because.</span></div>
      <details><summary>See the data behind this</summary><ul><li><a href="https://rival.com/x">rival.com/x</a></li></ul></details>
    </section>`
    expect(reportHtmlOutline(html).sections[0]?.content).toEqual([
      { tile: 'Mentions «negative|40% ↓» -5.0% vs 45%' },
      { row: ['«negative|Critical»', 'Lost citation × 2'] },
      { item: 'immediate Fix it Because.' },
      { summary: 'See the data behind this' },
      { item: '«link https://rival.com/x|rival.com/x»' },
    ])
  })

  test('an element boundary separates two words but never a number from its unit', () => {
    const html = `<section id="spacing">
      <p class="meta"><span>65</span><span>%</span> of <span>answers</span><span>cite you</span></p>
      <p class="meta">88<span>/100</span></p>
      <p class="meta"><span>$</span>1,200 raised</p>
      <p class="meta"><strong>Cited</strong>
        <span>in 3 answers</span></p>
      <p class="meta"><span>C</span>/<span>c</span></p>
      <p class="meta"><span>C</span> / <span>c</span></p>
    </section>`
    expect(reportHtmlOutline(html).sections[0]?.content).toEqual([
      // A split number reads as one token, and two words still read as two.
      { text: '65% of answers cite you' },
      { text: '88/100' },
      { text: '$1,200 raised' },
      // The HTML report's indentation is its own formatting, so the boundary it
      // wraps still reads as the one space a reader sees.
      { text: 'Cited in 3 answers' },
      // The deliberate blindness: away from a number a boundary reads as a
      // space, so a surface rendering `C/c` cannot be told from one rendering
      // `C / c`. See `glues` for why that is the safer of the two mistakes.
      { text: 'C / c' },
      { text: 'C / c' },
    ])
  })

  test('copy a reader hovers for is read, and a title that only repeats the words is not', () => {
    const html = `<section id="tips">
      <table class="report-table"><thead><tr><th>Score</th></tr></thead>
        <tbody><tr><td title="Opportunity score (0–100)">88</td></tr></tbody></table>
      <p class="meta"><span title="/pricing?gclid=abc">Google Ad · 2 params</span></p>
      <p class="meta"><span title="Truncated label">Truncated label</span></p>
    </section>`
    expect(reportHtmlOutline(html).sections[0]?.content).toEqual([
      { row: ['«tip Opportunity score (0–100)|88»'] },
      { text: '«tip /pricing?gclid=abc|Google Ad · 2 params»' },
      { text: 'Truncated label' },
    ])
  })

  test('a tone on a card that holds units marks each of them, instead of being swallowed', () => {
    // The shape of a diagnostics card: the accent IS the card's severity, and
    // it sits on a wrapper the walk would otherwise pass straight through.
    const html = `<section id="cards">
      <div class="diagnostic-card tone-negative"><h3>Provider citation coverage</h3><p>One provider returned zero.</p>
        <div class="proof-chips"><span class="proof-chip">openai: 0/2</span></div></div>
      <table class="report-table"><tbody><tr class="tone-caution"><td>Weak market</td><td>michigan</td></tr></tbody></table>
    </section>`
    expect(reportHtmlOutline(html).sections[0]?.content).toEqual([
      { text: '«negative|Provider citation coverage»' },
      { text: '«negative|One provider returned zero. openai: 0/2»' },
      { row: ['«caution|Weak market»', '«caution|michigan»'] },
    ])
  })
})
