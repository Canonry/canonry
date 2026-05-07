import type { ProjectReportDto, ReportActionPlanItem } from './report.js'

const REPORT_INTENT_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'from',
  'in',
  'near',
  'of',
  'on',
  'or',
  'the',
  'to',
])

function tokenizeReportIntent(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function normalizeReportIntentToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

export function reportIntentModifiers(report: ProjectReportDto): Set<string> {
  const location = report.meta.location
  if (!location) return new Set()
  return new Set(
    [location.label, location.city, location.region, location.country]
      .flatMap(tokenizeReportIntent)
      .map(normalizeReportIntentToken)
      .filter(Boolean),
  )
}

function reportIntentKey(value: string, modifiers: ReadonlySet<string>): string {
  const tokens = tokenizeReportIntent(value)
    .map(normalizeReportIntentToken)
    .filter(Boolean)
    .filter(token => !REPORT_INTENT_STOPWORDS.has(token))
    .filter(token => !modifiers.has(token))
  return [...new Set(tokens)].sort().join(' ')
}

function extractActionQuery(action: ReportActionPlanItem): string {
  return action.title.match(/"([^"]+)"/)?.[1]
    ?? action.successMetric.match(/"([^"]+)"/)?.[1]
    ?? action.title
}

export function dedupeReportActions(
  report: ProjectReportDto,
  actions: readonly ReportActionPlanItem[],
): ReportActionPlanItem[] {
  const modifiers = reportIntentModifiers(report)
  if (actions.length <= 1 || modifiers.size === 0) return [...actions]

  const seen = new Set<string>()
  const result: ReportActionPlanItem[] = []
  for (const action of actions) {
    if (action.category !== 'content') {
      result.push(action)
      continue
    }
    const key = reportIntentKey(extractActionQuery(action), modifiers)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(action)
  }
  return result
}

export function dedupeReportOpportunities(
  report: ProjectReportDto,
): ProjectReportDto['contentOpportunities'] {
  const modifiers = reportIntentModifiers(report)
  const opportunities = report.contentOpportunities
  if (opportunities.length <= 1 || modifiers.size === 0) return opportunities

  const seen = new Set<string>()
  return opportunities.filter((opportunity) => {
    const key = reportIntentKey(opportunity.query, modifiers)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
