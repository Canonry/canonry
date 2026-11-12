import { buildModelChangeNotice, formatPercent, formatSignedPointDelta, queryClassFilterSchema, type ModelPointerChangeDisclosure, type ProviderMetric, type QueryClassFilter, type WindowRateChange } from '@canonry/canonry-contracts'
import { createApiClient, type BrandMetricsDto, type GapAnalysisDto, type SourceBreakdownDto } from '../client.js'
import { CliError, isMachineFormat, usageError } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

export const ANALYTICS_USAGE =
  'canonry analytics <project> [--feature metrics|gaps|sources] [--window 7d|30d|90d|all] [--query-class all|branded|non-brand] [--format json]'

/** `--query-class` → the metrics and sources class filter. Undefined when the flag is absent. */
export function parseAnalyticsQueryClass(value: string | undefined): QueryClassFilter | undefined {
  if (value === undefined) return undefined
  const parsed = queryClassFilterSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const message = `--query-class must be one of ${queryClassFilterSchema.options.join(', ')}`
  throw usageError(`Error: ${message}\nUsage: ${ANALYTICS_USAGE}`, {
    message,
    details: { command: 'analytics', usage: ANALYTICS_USAGE, option: 'query-class', value },
  })
}

export async function showAnalytics(
  project: string,
  /** `queryClass` applies to metrics and sources; gaps has no class split. */
  options: { feature?: string; window?: string; queryClass?: QueryClassFilter; format?: string },
): Promise<void> {
  const client = getClient()
  const features = options.feature ? [options.feature] : ['metrics', 'gaps', 'sources']

  const results: Record<string, unknown> = {}

  for (const feature of features) {
    switch (feature) {
      case 'metrics': {
        const data = await client.getAnalyticsMetrics(project, options.window, options.queryClass)
        results.metrics = data
        if (!isMachineFormat(options.format)) printMetrics(data)
        break
      }
      case 'gaps': {
        const data = await client.getAnalyticsGaps(project, options.window)
        results.gaps = data
        if (!isMachineFormat(options.format)) printGaps(data)
        break
      }
      case 'sources': {
        const data = await client.getAnalyticsSources(project, { window: options.window, queryClass: options.queryClass })
        results.sources = data
        if (!isMachineFormat(options.format)) printSources(data)
        break
      }
      default:
        throw new CliError({
          code: 'INVALID_ANALYTICS_FEATURE',
          message: `Unknown analytics feature "${feature}"`,
          displayMessage: `Unknown feature: ${feature}. Use: metrics, gaps, sources`,
          details: {
            feature,
            validFeatures: ['metrics', 'gaps', 'sources'],
          },
        })
    }
  }

  if (isMachineFormat(options.format)) {
    console.log(JSON.stringify(results, null, 2))
  }
}

/** Widest `bucketDates` output ("YYYY-MM-DD → YYYY-MM-DD (NN sweeps)"), so the rate column lines up. */
const BUCKET_DATE_WIDTH = 35

/**
 * The dates a bucket's numbers actually come from. `startDate` is a synthetic
 * grouping boundary anchored to the window's earliest run — a sweep can fall
 * many days inside its own bucket — so printing it would date the reading to a
 * day nothing ran on. These are the real sweep timestamps, left in UTC: the CLI
 * has no viewer timezone to convert to, and the caller is told so in the header
 * rather than left to assume local time.
 */
function bucketDates(bucket: BrandMetricsDto['buckets'][number]): string {
  // A newer CLI can be pointed at an older server that predates these fields.
  const legacyCompatible = bucket as { dataStartDate?: string; dataEndDate?: string; sweepCount?: number }
  const start = legacyCompatible.dataStartDate?.slice(0, 10)
  const end = legacyCompatible.dataEndDate?.slice(0, 10)
  if (!start || !end) return 'date unavailable'
  // A bucket can pool several sweeps into one row. Say so — otherwise an
  // averaged multi-week reading is indistinguishable from a single run.
  const sweeps = legacyCompatible.sweepCount ?? 1
  const pooled = sweeps > 1 ? ` (${sweeps} sweeps)` : ''
  if (start === end) return `${start}${pooled}`
  return `${start} → ${end}${pooled}`
}

/** The answers a metrics response reads, for its header. A server that predates the field pooled both. */
const METRICS_QUERY_CLASS_LABEL: Record<QueryClassFilter, string> = {
  all: 'branded + non-brand queries',
  branded: 'branded queries',
  'non-brand': 'non-brand queries',
}

function printMetrics(data: BrandMetricsDto): void {
  const queryClass = (data as { queryClass?: QueryClassFilter }).queryClass ?? 'all'
  console.log(`\nCitation Rate Trends (${data.window}, ${METRICS_QUERY_CLASS_LABEL[queryClass]})`)
  console.log('─'.repeat(50))

  // BEFORE the first number, not after the last one. This is the note that
  // changes how everything below it should be read, and an operator who has
  // already scrolled past the rates has already formed the reading it is trying
  // to correct.
  const modelChangeNotice = buildModelChangeNotice(readModelPointerChanges(data))
  if (modelChangeNotice?.kind === 'change') {
    console.log(`\n  Model Updates Behind These Numbers:`)
    console.log(`    ${modelChangeNotice.text}`)
    console.log('')
  }

  console.log(`  Overall: ${citedFigure(data.overall)}`)
  console.log(`  Trend:   ${data.trend}`)
  printWindowChange(data)

  if (Object.keys(data.byProvider).length > 0) {
    console.log(`\n  By Provider:`)
    for (const [provider, metric] of Object.entries(data.byProvider)) {
      console.log(`    ${provider.padEnd(10)} ${citedFigure(metric, 6)}`)
    }
  }

  if (data.buckets.length > 0) {
    console.log(`\n  Timeline (dates in UTC):`)
    for (const bucket of data.buckets) {
      console.log(`    ${bucketDates(bucket).padEnd(BUCKET_DATE_WIDTH)}  ${citedBar(bucket)}`)
    }
  }

  // Per-provider timeline — parity with the dashboard's per-provider trend.
  // `?? {}` guards legacy/partial rows that predate the per-bucket breakdown.
  const providersInBuckets = [...new Set(data.buckets.flatMap(b => Object.keys(b.byProvider ?? {})))].sort()
  if (data.buckets.length > 0 && providersInBuckets.length > 0) {
    console.log(`\n  By Provider Timeline (dates in UTC):`)
    for (const provider of providersInBuckets) {
      console.log(`    ${provider}:`)
      for (const bucket of data.buckets) {
        const metric = bucket.byProvider?.[provider]
        if (!metric) continue // provider absent from this bucket
        console.log(`      ${bucketDates(bucket).padEnd(BUCKET_DATE_WIDTH)}  ${citedBar(metric)}`)
      }
    }
  }

  // The no-known-update state is context, not a caveat, so it rides down here
  // with the rest of the model evidence instead of interrupting the numbers.
  // The detail line is printed rather than dropped: it carries how recently the
  // record was checked, and without it "nothing on record" reads as proof that
  // nothing happened. The dashboard puts the same sentence in a tooltip; a
  // terminal has nowhere to hide it, so it goes on the next line.
  if (modelChangeNotice?.kind === 'no-known-change') {
    console.log(`\n  Model Updates Behind These Numbers:`)
    console.log(`    ${modelChangeNotice.text}`)
    console.log(`    ${modelChangeNotice.detail}`)
  }

  const attributionEntries = Object.entries(readModelAttribution(data))
    .sort(([a], [b]) => a.localeCompare(b))
  if (attributionEntries.length > 0) {
    console.log(`\n  Model Evidence:`)
    for (const [provider, attribution] of attributionEntries) {
      const latest = attribution.latestObservation
      console.log(`    ${provider}: latest ${formatModelEvidence(latest.state)} at ${latest.observedAt}`)
      for (const event of attribution.events) {
        // An anchored change happened somewhere between the last sweep before
        // this window and `observedAt` — it cannot be dated to the window. Say
        // so, and print the lower bound when we have one so the operator gets a
        // closed range instead of an open-ended "sometime earlier".
        const dating = event.fromPreWindowAnchor ? ' (on or before)' : ''
        const priorSweep = event.fromPreWindowAnchor && event.anchorObservedAt
          ? `  [last seen ${formatModelEvidence(event.from)} on ${event.anchorObservedAt}]`
          : ''
        console.log(`      ${event.observedAt}${dating}  ${formatModelEvidence(event.from)} → ${formatModelEvidence(event.to)}${priorSweep}`)
      }
      const eventTotal = attribution.eventTotal ?? attribution.events.length
      if (eventTotal > attribution.events.length) {
        console.log(`      Showing the latest ${attribution.events.length} of ${eventTotal} model changes.`)
      }
      if (attribution.anchorUnavailable) {
        console.log(`      We did not look far enough back to be sure this is every change.`)
      }
    }
  }

  const servedEntries = Object.entries(readServedModelAttribution(data))
    .sort(([a], [b]) => a.localeCompare(b))
  if (servedEntries.length > 0) {
    const mismatch = readModelServiceMismatch(data)
    console.log(`\n  What the Engines Answered With:`)
    for (const [provider, served] of servedEntries) {
      const rawIds = served.latestServedModelIds.length > 0
        ? served.latestServedModelIds.join(', ')
        : formatModelEvidence(served.latestObservation.state)
      const substituted = mismatch[provider]
      const note = substituted ? ` (not the ${formatModelEvidence(substituted.configured)} you selected)` : ''
      console.log(`    ${provider}: ${rawIds} at ${served.latestObservation.observedAt}${note}`)
      for (const event of served.events) {
        const dating = event.fromPreWindowAnchor ? ' (on or before)' : ''
        console.log(`      ${event.observedAt}${dating}  ${formatModelEvidence(event.from)} → ${formatModelEvidence(event.to)}`)
      }
    }
  }
}

/** The citation figure inputs; an older server omits `citationNotMeasured` and sends a numeric rate. */
/**
 * A cited rate with its base, both as the server sent them: the base is the
 * answers whose sources were checked (`citedTotal`). An engine that returns no
 * sources has no rate, so it reads "not measured", never 0%. An older server
 * sends no `citedTotal`; its base was every answer.
 */
function citedFigure(metric: ProviderMetric, rateWidth = 0): string {
  if (metric.citationRate === null) {
    return `not measured (${metric.total} ${metric.total === 1 ? 'answer' : 'answers'} without sources)`
  }
  const excluded = metric.citationNotMeasured > 0 ? `, ${metric.citationNotMeasured} not measured` : ''
  return `${formatPercent(metric.citationRate).padStart(rateWidth)} (${metric.cited}/${metric.citedTotal ?? metric.total}${excluded})`
}

/** One timeline row's rate and bar; a point with no checked answer has neither. */
function citedBar(metric: ProviderMetric): string {
  if (metric.citationRate === null) return `${'n/m'.padStart(6)}  not measured`
  const bar = metric.total > 0 ? '█'.repeat(Math.round(metric.citationRate * 20)) : ''
  return `${formatPercent(metric.citationRate).padStart(6)}  ${bar}`
}

/**
 * Each series' change from its first to its latest bucket: the server's
 * `windowChange`, the figure the dashboard's trend head prints beside the
 * latest rate. Mention share names its query class, because a non-brand share
 * and a pooled one answer different questions.
 */
function printWindowChange(data: BrandMetricsDto): void {
  // A newer CLI can be pointed at an older server that predates the field.
  const windowChange = (data as { windowChange?: BrandMetricsDto['windowChange'] }).windowChange
  if (!windowChange) return
  const shareScope = data.mentionShareScope === 'non-brand'
    ? 'non-brand queries'
    : 'pooled queries · classification unavailable'
  const series: Array<[string, WindowRateChange | null]> = [
    ['Mentioned', windowChange.mentionRate],
    ['Cited', windowChange.citationRate],
    [`Mention share · ${shareScope}`, windowChange.mentionShare],
  ]
  // Buckets whose answers all lack sources carry no cited rate; with no other
  // bucket, citation was never measured in this window.
  const citationNotMeasured = data.buckets.length > 0 && data.buckets.every(bucket => bucket.citationRate === null)
  console.log(`\n  Change Across the Window (first → latest bucket):`)
  for (const [label, change] of series) {
    const text = change
      ? `${formatPercent(change.first)} → ${formatPercent(change.latest)} (${formatSignedPointDelta(change.delta)})`
      : label === 'Cited' && citationNotMeasured
        ? 'not measured (no answer in this window carries sources)'
        : 'fewer than two buckets to compare'
    console.log(`    ${label}: ${text}`)
  }
}

/** A newer CLI can be pointed at an older server during a rolling upgrade. */
function readServedModelAttribution(data: BrandMetricsDto): BrandMetricsDto['servedModelAttribution'] {
  const legacyCompatible = data as unknown as { servedModelAttribution?: BrandMetricsDto['servedModelAttribution'] }
  return legacyCompatible.servedModelAttribution ?? {}
}

function readModelServiceMismatch(data: BrandMetricsDto): BrandMetricsDto['modelServiceMismatch'] {
  const legacyCompatible = data as unknown as { modelServiceMismatch?: BrandMetricsDto['modelServiceMismatch'] }
  return legacyCompatible.modelServiceMismatch ?? {}
}

/**
 * Providers whose numbers were produced by a model id the provider is free to
 * re-point at a different underlying model without the API response changing at
 * all. Absent on an older server, empty for a project on fixed model ids.
 */
function readModelPointerChanges(data: BrandMetricsDto): Record<string, ModelPointerChangeDisclosure> {
  const legacyCompatible = data as unknown as { modelPointerChanges?: Record<string, ModelPointerChangeDisclosure> }
  return legacyCompatible.modelPointerChanges ?? {}
}

/** A newer CLI can be pointed at an older server during a rolling upgrade. */
function readModelAttribution(data: BrandMetricsDto): BrandMetricsDto['modelAttribution'] {
  const legacyCompatible = data as unknown as { modelAttribution?: BrandMetricsDto['modelAttribution'] }
  return legacyCompatible.modelAttribution ?? {}
}

function formatModelEvidence(state: BrandMetricsDto['modelAttribution'][string]['latestObservation']['state']): string {
  switch (state.status) {
    case 'known':
      return `known ${state.model}`
    case 'unknown':
      return 'unknown'
    case 'mixed':
      return `mixed ${state.models.join(', ')}${state.includesUnknown ? ' + unknown' : ''}`
  }
}

/**
 * The runs a query's citation consistency is out of, as the server sent it:
 * those where an answer's sources were checked. An older server sends no
 * `citedTotalRuns`; its base was every run.
 */
function citedRunBase(consistency: GapAnalysisDto['cited'][number]['consistency']): number {
  return consistency.citedTotalRuns ?? consistency.totalRuns
}

function printGaps(data: GapAnalysisDto): void {
  // An older server omits the lane; none of its queries was set apart.
  const notMeasured = data.citationNotMeasured ?? []
  console.log(`\nBrand Gap Analysis`)
  console.log('─'.repeat(50))
  console.log(`  Cited: ${data.cited.length}  |  Gap: ${data.gap.length}  |  Uncited: ${data.uncited.length}${notMeasured.length > 0 ? `  |  Not measured: ${notMeasured.length}` : ''}`)

  if (data.gap.length > 0) {
    console.log(`\n  Opportunity Gaps (competitors cited, you're not):`)
    for (const q of data.gap) {
      const competitors = q.competitorsCiting.join(', ')
      const cons = citedRunBase(q.consistency) > 0
        ? ` [cited ${q.consistency.citedRuns}/${citedRunBase(q.consistency)} runs]`
        : ''
      console.log(`    • ${q.query}${cons}`)
      console.log(`      Competitors: ${competitors}`)
    }
  }

  if (data.cited.length > 0) {
    console.log(`\n  Cited Queries:`)
    for (const q of data.cited) {
      const cons = citedRunBase(q.consistency) > 0
        ? ` [${q.consistency.citedRuns}/${citedRunBase(q.consistency)} runs]`
        : ''
      console.log(`    ✓ ${q.query} (${q.providers.join(', ')})${cons}`)
    }
  }

  if (notMeasured.length > 0) {
    console.log(`\n  Citations Not Measured (no answer carries sources):`)
    for (const q of notMeasured) console.log(`    · ${q.query}`)
  }
}

function printSources(data: SourceBreakdownDto): void {
  console.log(`\nSource Origin Breakdown`)
  console.log('─'.repeat(50))

  if (data.overall.length === 0) {
    console.log('  No source data available')
    return
  }

  for (const cat of data.overall) {
    const domains = cat.topDomains.slice(0, 3).map((d: { domain: string }) => d.domain).join(', ')
    console.log(`  ${cat.label.padEnd(20)} ${formatPercent(cat.percentage).padStart(6)}  (${cat.count})  ${domains}`)
  }
}
