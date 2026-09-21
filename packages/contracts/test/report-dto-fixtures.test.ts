import { describe, expect, test } from 'vitest'
import { projectReportDtoSchema } from '../src/report.js'
import { MIN_TREND_POINTS } from '../src/trend-stability.js'
import {
  advancedReport,
  emptyReport,
  fullReport,
  reportWithChangeHistory,
  richReport,
  simpleVisibility,
} from './fixtures/report-dto.js'

/**
 * The report fixtures feed the HTML byte snapshots, the outline goldens and the
 * SPA parity suite. A fixture the contract would reject tests a report no
 * server can produce, so each one must parse.
 */
describe('shared report DTO fixtures', () => {
  const builders = [
    ['emptyReport', emptyReport],
    ['richReport', richReport],
    ['reportWithChangeHistory', reportWithChangeHistory],
    ['fullReport', fullReport],
    ['advancedReport', advancedReport],
    ['richReport with a simple visibility selection', () => ({ ...richReport(), visibility: simpleVisibility() })],
  ] as const

  test.each(builders)('%s satisfies the report contract', (_name, build) => {
    const parsed = projectReportDtoSchema.safeParse(build())
    expect(parsed.success ? [] : parsed.error.issues).toEqual([])
    // Parsing alone is too weak: `safeParse` FILLS IN every field the schema
    // defaults, so a fixture missing one still passes while the renderers, the
    // byte snapshots and the SPA parity suite all read the raw object, where
    // that field is undefined — a state no server-built DTO is ever in.
    expect(parsed.success ? parsed.data : null).toEqual(build())
  })

  test.each(builders)('%s returns a fresh object on every call', (_name, build) => {
    const first = build()
    first.meta.project.name = 'mutated'
    first.insights.push({ ...richReport().insights[0]!, id: 'mutated' })
    const second = build()
    expect(second.meta.project.name).not.toBe('mutated')
    expect(second.insights.map(insight => insight.id)).not.toContain('mutated')
  })

  test('fullReport switches on every branch its outline golden depends on', () => {
    const report = fullReport()
    expect(report.whatsChanged.enoughHistory).toBe(true)
    expect(report.whatsChanged.providerMovements.map(movement => movement.direction)).toEqual(['up', 'flat'])
    expect(report.whatsChanged.wins.map(win => win.instanceCount)).toEqual([2])
    expect(report.whatsChanged.regressions).toHaveLength(1)
    expect(report.insights.map(insight => [insight.instanceCount, insight.recommendation])).toEqual([
      [3, 'review-content — /landing — rival outranking'],
      [1, null],
    ])
    expect(report.meta.providerLocationHandling.map(handling => handling.treatment)).toEqual(['prompt', 'request-param', 'browser-geo'])
    expect(report.citationScorecard.matrix.at(-1)).toEqual([{ citationState: 'cited', answerMentioned: null, model: 'g-2.0' }, null])
    expect(report.competitorLandscape.competitors[0]!.theirCitedPages).toHaveLength(1)
    expect(report.aiSourceOrigin.categories.map(category => category.category)).toEqual(['forum', 'news', 'competitor'])
    expect(report.gsc?.trackedButNoGsc).toEqual(['answer engine'])
    expect(report.gsc?.gscButNotTracked).toEqual(['aeo software pricing'])
    expect(report.ga?.topLandingPages.map(page => page.page)).toEqual(['/', '/pricing?gclid=abc&utm_source=x'])
    expect(report.serverActivity?.referralRedirects).toBe(120)
    expect(report.serverActivity?.topCrawledPaths[0]).toEqual({ path: '/blog/foo', verifiedHits: 80, unverifiedHits: 15, distinctOperators: 2 })
    expect(report.citationsTrend).toHaveLength(MIN_TREND_POINTS)
    expect(report.agencyDiagnostics.diagnostics.map(diagnostic => diagnostic.title)).toEqual([
      'Provider citation coverage',
      'Search demand mismatch',
      'Location caveat',
    ])
    expect(report.contentGaps.map(gap => gap.competitorDomains.length)).toEqual([1, 6])
    expect(report.contentGaps[1]!.missRate).toBe(0.5)
  })

  test('advancedReport is richReport with only the visibility selection added', () => {
    const { visibility, ...rest } = advancedReport()
    expect(visibility?.selection.mode).toBe('advanced')
    expect(rest).toEqual(richReport())
  })
})
