import { createApiClient, type BrandMetricsDto, type GapAnalysisDto, type SourceBreakdownDto } from '../client.js'
import { CliError, isMachineFormat } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

export async function showAnalytics(
  project: string,
  options: { feature?: string; window?: string; format?: string },
): Promise<void> {
  const client = getClient()
  const features = options.feature ? [options.feature] : ['metrics', 'gaps', 'sources']

  const results: Record<string, unknown> = {}

  for (const feature of features) {
    switch (feature) {
      case 'metrics': {
        const data = await client.getAnalyticsMetrics(project, options.window)
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
        const data = await client.getAnalyticsSources(project, { window: options.window })
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

function printMetrics(data: BrandMetricsDto): void {
  console.log(`\nCitation Rate Trends (${data.window})`)
  console.log('─'.repeat(50))

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`

  console.log(`  Overall: ${pct(data.overall.citationRate)} (${data.overall.cited}/${data.overall.total})`)
  console.log(`  Trend:   ${data.trend}`)

  if (Object.keys(data.byProvider).length > 0) {
    console.log(`\n  By Provider:`)
    for (const [provider, metric] of Object.entries(data.byProvider) as [string, { cited: number; total: number; citationRate: number }][]) {
      console.log(`    ${provider.padEnd(10)} ${pct(metric.citationRate).padStart(6)} (${metric.cited}/${metric.total})`)
    }
  }

  if (data.buckets.length > 0) {
    console.log(`\n  Timeline:`)
    for (const bucket of data.buckets) {
      const start = bucket.startDate.slice(0, 10)
      const bar = bucket.total > 0 ? '█'.repeat(Math.round(bucket.citationRate * 20)) : ''
      console.log(`    ${start}  ${pct(bucket.citationRate).padStart(6)}  ${bar}`)
    }
  }

  // Per-provider timeline — parity with the dashboard's per-provider trend.
  // `?? {}` guards legacy/partial rows that predate the per-bucket breakdown.
  const providersInBuckets = [...new Set(data.buckets.flatMap(b => Object.keys(b.byProvider ?? {})))].sort()
  if (data.buckets.length > 0 && providersInBuckets.length > 0) {
    console.log(`\n  By Provider Timeline:`)
    for (const provider of providersInBuckets) {
      console.log(`    ${provider}:`)
      for (const bucket of data.buckets) {
        const metric = bucket.byProvider?.[provider]
        if (!metric) continue // provider absent from this bucket
        const start = bucket.startDate.slice(0, 10)
        const bar = metric.total > 0 ? '█'.repeat(Math.round(metric.citationRate * 20)) : ''
        console.log(`      ${start}  ${pct(metric.citationRate).padStart(6)}  ${bar}`)
      }
    }
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
      const note = substituted ? ` — not the ${formatModelEvidence(substituted.configured)} you selected` : ''
      console.log(`    ${provider}: ${rawIds} at ${served.latestObservation.observedAt}${note}`)
      for (const event of served.events) {
        const dating = event.fromPreWindowAnchor ? ' (on or before)' : ''
        console.log(`      ${event.observedAt}${dating}  ${formatModelEvidence(event.from)} → ${formatModelEvidence(event.to)}`)
      }
    }
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

function printGaps(data: GapAnalysisDto): void {
  console.log(`\nBrand Gap Analysis`)
  console.log('─'.repeat(50))
  console.log(`  Cited: ${data.cited.length}  |  Gap: ${data.gap.length}  |  Uncited: ${data.uncited.length}`)

  if (data.gap.length > 0) {
    console.log(`\n  Opportunity Gaps (competitors cited, you're not):`)
    for (const q of data.gap) {
      const competitors = q.competitorsCiting.join(', ')
      const cons = q.consistency.totalRuns > 0
        ? ` [cited ${q.consistency.citedRuns}/${q.consistency.totalRuns} runs]`
        : ''
      console.log(`    • ${q.query}${cons}`)
      console.log(`      Competitors: ${competitors}`)
    }
  }

  if (data.cited.length > 0) {
    console.log(`\n  Cited Queries:`)
    for (const q of data.cited) {
      const cons = q.consistency.totalRuns > 0
        ? ` [${q.consistency.citedRuns}/${q.consistency.totalRuns} runs]`
        : ''
      console.log(`    ✓ ${q.query} (${q.providers.join(', ')})${cons}`)
    }
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
    const pct = `${(cat.percentage * 100).toFixed(1)}%`
    const domains = cat.topDomains.slice(0, 3).map((d: { domain: string }) => d.domain).join(', ')
    console.log(`  ${cat.label.padEnd(20)} ${pct.padStart(6)}  (${cat.count})  ${domains}`)
  }
}
