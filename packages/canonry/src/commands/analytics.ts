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
        const data = await client.getAnalyticsSources(project, options.window)
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
