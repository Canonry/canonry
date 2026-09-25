import { describe, expect, test } from 'vitest'
import { RATIO_UNIT_META_KEY, undeclaredRatioFields } from '@ainyc/canonry-contracts'
import { buildComponentSchemas } from '../src/openapi-schemas.js'

/**
 * Every ratio on the wire declares its unit (`fraction` 0..1 or `percent`
 * 0..100) on its schema, because the same name carries both units on
 * different endpoints and a reader, human or agent, cannot tell 0.0207 from
 * 2.07 by the name alone. This walks every registered response schema and
 * fails on a ratio-named number with no declared unit, so a new field has to
 * say which it is.
 */

/** Names that match the ratio pattern but are not ratios, with the reason. */
const NOT_A_RATIO: Readonly<Record<string, string>> = {
  rateRatio: 'A multiplier (`to.point / from.point`, so 1.5 is one and a half times), not a share of anything.',
  daysWithEngagementRate: 'A count of days that carried an engagement-rate reading, not a rate.',
}

type JsonSchema = Record<string, unknown>

function isNode(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A node plus every union member under it, so `.nullable()` and variants are searched too. */
function withMembers(node: JsonSchema): JsonSchema[] {
  const members = (['anyOf', 'oneOf', 'allOf'] as const)
    .flatMap(key => (Array.isArray(node[key]) ? (node[key] as unknown[]).filter(isNode) : []))
  return [node, ...members.flatMap(withMembers)]
}

describe('ratio units on the wire', () => {
  const schemas = buildComponentSchemas()

  test('every ratio-named number in a registered schema declares its unit', () => {
    const missing = Object.entries(schemas).flatMap(([name, schema]) => undeclaredRatioFields(schema, name, NOT_A_RATIO))
    expect(missing.sort()).toEqual([])
  })

  test('every exclusion still names a field in a registered schema', () => {
    const document = JSON.stringify(schemas)
    for (const name of Object.keys(NOT_A_RATIO)) expect(document, name).toContain(`"${name}":{`)
  })

  test('a field whose name reads one way declares the unit it actually carries', () => {
    /**
     * The unit declared at a path: `[]` steps into array items, `*` into record
     * values, anything else into a property. `missing` when the path names
     * nothing, `mixed` when union variants disagree.
     */
    const unitAt = (name: string, ...path: string[]): string => {
      let nodes: JsonSchema[] = schemas[name] ? [schemas[name]] : []
      for (const key of path) {
        nodes = nodes.flatMap(withMembers).flatMap((node): unknown[] => {
          if (key === '[]') return [node.items]
          if (key === '*') return [node.additionalProperties]
          return [isNode(node.properties) ? node.properties[key] : undefined]
        }).filter(isNode)
      }
      if (nodes.length === 0) return 'missing'
      const units = new Set(nodes.flatMap(withMembers).map(node => node[RATIO_UNIT_META_KEY]).filter(unit => unit !== undefined))
      if (units.size > 1) return 'mixed'
      return units.size === 1 ? String([...units][0]) : 'undeclared'
    }

    // `percentage` is a 0..1 share in the source reads...
    expect(unitAt('SourceBreakdownDto', 'ranked', 'entries', '[]', 'percentage')).toBe('fraction')
    expect(unitAt('SourceBreakdownDto', 'ranked', 'entries', '[]', 'answerShare')).toBe('fraction')
    // ...and a one-decimal 0..100 percent in the index-coverage reads.
    expect(unitAt('BingCoverageSummaryDto', 'summary', 'percentage')).toBe('percent')
    expect(unitAt('GscCoverageSummaryDto', 'summary', 'percentage')).toBe('percent')

    // `citationRate` is a fraction in analytics and a whole 0..100 percent in the report.
    expect(unitAt('BrandMetricsDto', 'overall', 'citationRate')).toBe('fraction')
    expect(unitAt('BrandMetricsDto', 'buckets', '[]', 'byProvider', '*', 'mentionRate')).toBe('fraction')
    expect(unitAt('ProjectReportDto', 'executiveSummary', 'citationRate')).toBe('percent')
    expect(unitAt('ProjectReportDto', 'citationScorecard', 'providerRates', '[]', 'citationRate')).toBe('percent')
    expect(unitAt('ProjectReportDto', 'citationsTrend', '[]', 'mentionRate')).toBe('percent')

    // One DTO, two units: the overview's query counts are fractions, its run history whole percents.
    expect(unitAt('ProjectOverviewDto', 'queryCounts', 'citedRate')).toBe('fraction')
    expect(unitAt('ProjectOverviewDto', 'runHistory', '[]', 'citationRate')).toBe('percent')

    // A click-through rate stays a fraction even inside the percent-heavy report.
    expect(unitAt('ProjectReportDto', 'gsc', 'ctr')).toBe('fraction')
    expect(unitAt('ProjectReportDto', 'gsc', 'categoryBreakdown', '[]', 'sharePct')).toBe('percent')

    // A signed change: `deltaPct` is on the 0..100 scale, a GSC period change is a ratio (0.5 = +50%).
    expect(unitAt('ProjectReportDto', 'whatsChanged', 'citationRate', 'deltaPct')).toBe('percent')
    expect(unitAt('GscPerformanceDailyDto', 'periodComparison', 'change', 'ctr')).toBe('fraction')
    expect(unitAt('GscPerformanceDailyDto', 'periodComparison', 'change', 'clicks')).toBe('fraction')

    // An audit factor's share of the score is a 0..100 percent on every Site
    // Health read. Its weight is relative (the core set sums to 111), not a ratio.
    expect(unitAt('SiteAuditScoreDto', 'factors', '[]', 'sharePct')).toBe('percent')
    expect(unitAt('SiteAuditPagesResponseDto', 'pages', '[]', 'factors', '[]', 'sharePct')).toBe('percent')
    expect(unitAt('SiteCrawlPageAuditDto', 'factors', '[]', 'sharePct')).toBe('percent')
    expect(unitAt('SiteAuditScoreDto', 'factors', '[]', 'weight')).toBe('undeclared')

    // Ratios the name pattern cannot see still declare their unit.
    expect(unitAt('MeasurementOverviewResponse', 'metrics', 'mentionCoverage', 'value')).toBe('fraction')
    expect(unitAt('VisibilityCompareDto', 'metrics', '[]', 'from', 'point')).toBe('fraction')
    expect(unitAt('CompetitorLandscapeResponse', 'project', 'shareOfVoice')).toBe('percent')
    expect(unitAt('VisibilityStatsDto', 'shareOfVoice', 'percent')).toBe('percent')

    // `propertiesMentioned` shares the metric shape but its value is a count of
    // Properties, so it declares no unit: a reader showing ratios as percents
    // must never turn "12 Properties" into "1200.0%".
    expect(unitAt('MeasurementOverviewResponse', 'metrics', 'propertiesMentioned', 'value')).toBe('undeclared')
    expect(unitAt('MeasurementPortfolioSummaryResponse', 'metrics', 'propertiesMentioned', 'value')).toBe('undeclared')
    expect(unitAt('MeasurementPortfolioSummaryResponse', 'markets', '[]', 'propertiesMentioned', 'value')).toBe('undeclared')
    expect(unitAt('MeasurementChangesResponse', 'comparison', 'metrics', 'propertiesMentioned', 'delta')).toBe('undeclared')
    expect(unitAt('MeasurementChangesResponse', 'comparison', 'metrics', 'mentionCoverage', 'delta')).toBe('fraction')

    // An exclusion stays undeclared rather than borrowing a unit, and a path
    // that names nothing reads as missing, never as a unit.
    expect(unitAt('VisibilityCompareDto', 'metrics', '[]', 'rateRatio')).toBe('undeclared')
    expect(unitAt('ProjectReportDto', 'citationScorecard', 'rows', '[]', 'citationRate')).toBe('missing')
  })
})
