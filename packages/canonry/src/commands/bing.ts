import type { BingSearchComparisonDto, BingTrafficResponseDto, RunDetailDto } from '@canonry/canonry-contracts'
import { describeError, formatPercent, formatRunErrorOneLine } from '@canonry/canonry-contracts'
import { type ApiClient, createApiClient } from '../client.js'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

async function waitForRunStatus(
  client: ApiClient,
  runId: string,
  config: {
    timeoutMs: number
    intervalMs: number
    progressLabel: string
    successStatuses: string[]
    failureStatuses: string[]
    timeoutCode: string
    failureCode: string
    timeoutMessage: string
    failureMessage: string
    details?: Record<string, unknown>
  },
): Promise<RunDetailDto> {
  const start = Date.now()
  process.stderr.write(config.progressLabel)

  while (Date.now() - start < config.timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs))
    const current = await client.getRun(runId)
    process.stderr.write('.')

    if (config.successStatuses.includes(current.status)) {
      process.stderr.write('\n')
      return current
    }

    if (config.failureStatuses.includes(current.status)) {
      process.stderr.write('\n')
      throw new CliError({
        code: config.failureCode,
        message: config.failureMessage,
        displayMessage: config.failureMessage,
        details: { runId, status: current.status, ...(config.details ?? {}) },
      })
    }
  }

  process.stderr.write('\n')
  throw new CliError({
    code: config.timeoutCode,
    message: config.timeoutMessage,
    displayMessage: config.timeoutMessage,
    details: { runId, ...(config.details ?? {}) },
  })
}

export async function bingConnect(project: string, opts?: { apiKey?: string; format?: string }): Promise<void> {
  const apiKey = opts?.apiKey

  if (!apiKey) {
    throw new CliError({
      code: 'BING_API_KEY_REQUIRED',
      message: 'API key is required. Pass --api-key <key>.',
      displayMessage: 'Error: API key is required. Pass --api-key <key>.',
      details: {
        project,
      },
    })
  }

  const client = getClient()
  const result = await client.bingConnect(project, { apiKey }) as {
    connected: boolean
    domain: string
    availableSites: Array<{ url: string; verified: boolean }>
  }

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Bing Webmaster Tools connected for project "${project}".`)

  if (result.availableSites.length > 0) {
    console.log(`\nRegistered sites:`)
    for (const site of result.availableSites) {
      const verified = site.verified ? ' (verified)' : ''
      console.log(`  ${site.url}${verified}`)
    }
    console.log(`\nSet the active site with: canonry bing set-site ${project} <url>`)
  } else {
    console.log('\nNo sites found. Register your site at https://www.bing.com/webmasters/')
  }
}

export async function bingDisconnect(project: string, format?: string): Promise<void> {
  const client = getClient()
  await client.bingDisconnect(project)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, disconnected: true }, null, 2))
    return
  }

  console.log(`Bing Webmaster Tools disconnected from project "${project}".`)
}

export async function bingStatus(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.bingStatus(project) as {
    connected: boolean
    domain: string
    siteUrl: string | null
    createdAt: string | null
    updatedAt: string | null
  }

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (!result.connected) {
    console.log(`No Bing connection for project "${project}".`)
    console.log('Run "canonry bing connect <project>" to connect.')
    return
  }

  console.log(`Bing Webmaster Tools for "${project}":\n`)
  console.log(`  Site URL:     ${result.siteUrl ?? '(not set)'}`)
  console.log(`  Connected:    ${result.createdAt}`)
  console.log(`  Updated:      ${result.updatedAt}`)
}

export async function bingSites(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.bingSites(project) as {
    sites: Array<{ url: string; verified: boolean }>
  }

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  } else if (format === 'jsonl') {
    emitJsonl(result.sites.map((site) => ({ project, ...site })))
    return
  }

  if (result.sites.length === 0) {
    console.log('No sites registered in Bing Webmaster Tools.')
    console.log('Register your site at https://www.bing.com/webmasters/')
    return
  }

  console.log('Bing Webmaster Tools sites:\n')
  const urlWidth = Math.max(10, ...result.sites.map((s) => s.url.length))
  console.log(`  ${'URL'.padEnd(urlWidth)}  VERIFIED`)
  console.log(`  ${'─'.repeat(urlWidth)}  ${'─'.repeat(8)}`)
  for (const site of result.sites) {
    console.log(`  ${site.url.padEnd(urlWidth)}  ${site.verified ? 'Yes' : 'No'}`)
  }
  console.log(`\nUse "canonry bing set-site <project> <url>" to select a site.`)
}

export async function bingSetSite(project: string, siteUrl: string, format?: string): Promise<void> {
  const client = getClient()
  await client.bingSetSite(project, siteUrl)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, siteUrl }, null, 2))
    return
  }

  console.log(`Bing site set to "${siteUrl}" for project "${project}".`)
}

export async function bingCoverage(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.bingCoverage(project) as {
    summary: { total: number; indexed: number; notIndexed: number; unknown?: number; percentage: number }
    lastInspectedAt: string | null
    indexed: Array<{ url: string; inIndex: boolean | null; lastCrawledDate: string | null }>
    notIndexed: Array<{ url: string; inIndex: boolean | null; httpCode: number | null }>
    unknown?: Array<{ url: string; inIndex: boolean | null; httpCode: number | null }>
  }

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const { summary } = result
  if (summary.total === 0) {
    if ((summary.unknown ?? 0) > 0) {
      console.log('No URLs have a definitive Bing index status yet.')
      console.log('Run more inspections or use --format json to review the unknown responses.')
      return
    }
    console.log('No URL inspections found. Run "canonry bing inspect <project> <url>" first.')
    return
  }

  const reset = '\x1b[0m'
  let pctColor: string
  if (summary.percentage >= 80) pctColor = '\x1b[32m'
  else if (summary.percentage >= 50) pctColor = '\x1b[33m'
  else pctColor = '\x1b[31m'

  const unknownNote = (summary.unknown ?? 0) > 0 ? `, ${summary.unknown} unknown` : ''

  console.log(`\nBing Index Coverage for "${project}"\n`)
  console.log(`  SUMMARY: ${pctColor}${summary.indexed} / ${summary.total} pages indexed (${formatPercent(summary.percentage, 'percent')})${reset}${unknownNote}\n`)

  if (result.indexed.length > 0) {
    console.log(`  INDEXED (${result.indexed.length}):`)
    for (const page of result.indexed) {
      const crawl = page.lastCrawledDate ? ` (crawled: ${page.lastCrawledDate.split('T')[0]})` : ''
      console.log(`    ${page.url}${crawl}`)
    }
    console.log()
  }

  if (result.notIndexed.length > 0) {
    console.log(`  NOT INDEXED (${result.notIndexed.length}):`)
    for (const page of result.notIndexed) {
      const code = page.httpCode ? ` — HTTP ${page.httpCode}` : ''
      console.log(`    ${page.url}${code}`)
    }
    console.log()
  }

  if (result.lastInspectedAt) {
    console.log(`  Last inspected: ${result.lastInspectedAt}`)
  }
}

export async function bingCoverageHistory(project: string, opts: { limit?: number; format?: string }): Promise<void> {
  const client = getClient()
  const rows = await client.bingCoverageHistory(project, { limit: opts.limit })

  if (opts.format === 'json') {
    console.log(JSON.stringify(rows, null, 2))
    return
  } else if (opts.format === 'jsonl') {
    emitJsonl(rows.map((row) => ({ project, ...row })))
    return
  }

  if (rows.length === 0) {
    console.log('No coverage history found. Run "canonry bing coverage" or "canonry bing refresh" first to capture a snapshot.')
    return
  }

  console.log(`\nBing Coverage History for "${project}" (${rows.length} snapshots):\n`)
  console.log(`  ${'DATE'.padEnd(12)}${'INDEXED'.padEnd(10)}${'NOT INDEXED'.padEnd(14)}UNKNOWN`)
  console.log(`  ${'─'.repeat(12)}${'─'.repeat(10)}${'─'.repeat(14)}${'─'.repeat(10)}`)
  for (const row of rows) {
    console.log(`  ${row.date.padEnd(12)}${String(row.indexed).padEnd(10)}${String(row.notIndexed).padEnd(14)}${String(row.unknown)}`)
  }
}

export async function bingInspect(project: string, url: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.bingInspectUrl(project, url) as {
    url: string
    httpCode: number | null
    inIndex: boolean | null
    lastCrawledDate: string | null
    inIndexDate: string | null
    inspectedAt: string
    documentSize: number | null
    anchorCount: number | null
    discoveryDate: string | null
  }

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const indexLabel = result.inIndex === true
    ? `yes${result.documentSize != null ? ` (document size: ${result.documentSize.toLocaleString()} bytes)` : ''}`
    : result.inIndex === false
      ? 'no'
      : 'unknown'

  console.log(`\nBing URL Inspection: ${result.url}\n`)
  console.log(`  In Index:          ${indexLabel}`)
  console.log(`  Last Crawled:      ${result.lastCrawledDate ? result.lastCrawledDate.split('T')[0] : 'never'}`)
  console.log(`  Discovery Date:    ${result.discoveryDate ? result.discoveryDate.split('T')[0] : 'unknown'}`)
  if (result.anchorCount != null) {
    console.log(`  Inbound Links:     ${result.anchorCount}`)
  }
  console.log(`  Inspected At:      ${result.inspectedAt}`)
}

export async function bingInspections(project: string, opts: { url?: string; format?: string }): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  if (opts.url) params.url = opts.url

  const rows = await client.bingInspections(project, Object.keys(params).length > 0 ? params : undefined) as Array<{
    id: string
    url: string
    httpCode: number | null
    inIndex: boolean | null
    lastCrawledDate: string | null
    inspectedAt: string
  }>

  if (opts.format === 'json') {
    console.log(JSON.stringify(rows, null, 2))
    return
  } else if (opts.format === 'jsonl') {
    emitJsonl(rows.map((row) => ({ project, ...row })))
    return
  }

  if (rows.length === 0) {
    console.log('No Bing URL inspections found.')
    return
  }

  console.log(`Bing URL inspection history (${rows.length} records):\n`)
  const urlWidth = Math.min(50, Math.max(10, ...rows.map((r) => r.url.length)))
  console.log(`  ${'URL'.padEnd(urlWidth)}  ${'INDEXED'.padEnd(9)}${'HTTP'.padEnd(6)}${'INSPECTED'.padEnd(22)}`)
  console.log(`  ${'─'.repeat(urlWidth)}  ${'─'.repeat(9)}${'─'.repeat(6)}${'─'.repeat(22)}`)
  for (const row of rows) {
    const url = row.url.length > urlWidth ? row.url.slice(0, urlWidth - 3) + '...' : row.url
    const indexed = row.inIndex === true ? 'Yes' : row.inIndex === false ? 'No' : '?'
    console.log(
      `  ${url.padEnd(urlWidth)}  ${indexed.padEnd(9)}${String(row.httpCode ?? '?').padEnd(6)}${row.inspectedAt}`,
    )
  }
}

export async function bingRefresh(project: string, format?: string): Promise<void> {
  const client = getClient()

  // Fetch all previously inspected URLs
  const rows = await client.bingInspections(project) as Array<{ url: string }>
  const uniqueUrls = [...new Set(rows.map((r) => r.url))]

  if (uniqueUrls.length === 0) {
    if (isMachineFormat(format)) {
      console.log(JSON.stringify({ refreshed: 0, message: 'No previously inspected URLs to refresh.' }, null, 2))
      return
    }
    console.log('No previously inspected URLs to refresh. Run "canonry bing inspect <project> <url>" first.')
    return
  }

  if (!isMachineFormat(format)) {
    process.stderr.write(`Re-inspecting ${uniqueUrls.length} URL(s) via Bing`)
  }

  // Re-inspect each URL with concurrency limit (same as UI refresh)
  const CONCURRENCY = 10
  const errors: string[] = []

  for (let i = 0; i < uniqueUrls.length; i += CONCURRENCY) {
    const batch = uniqueUrls.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map((url) => client.bingInspectUrl(project, url)),
    )
    for (const r of results) {
      if (r.status === 'rejected') {
        errors.push(describeError(r.reason))
      }
    }
    if (!isMachineFormat(format)) {
      process.stderr.write('.')
    }
  }

  if (!isMachineFormat(format)) {
    process.stderr.write('\n')
  }
  if (errors.length > 0) {
    process.stderr.write(`${errors.length} URL(s) failed to re-inspect.\n`)
  }

  // Display updated coverage (same as `canonry bing coverage`)
  await bingCoverage(project, format)
}

export async function bingRequestIndexing(project: string, opts: {
  url?: string
  allUnindexed?: boolean
  format?: string
}): Promise<void> {
  const client = getClient()

  const body: { urls?: string[]; allUnindexed?: boolean } = {}
  if (opts.allUnindexed) {
    body.allUnindexed = true
  } else if (opts.url) {
    body.urls = [opts.url]
  } else {
    throw new CliError({
      code: 'CLI_USAGE_ERROR',
      message: 'provide a URL or use --all-unindexed',
      displayMessage: 'Error: provide a URL or use --all-unindexed',
      details: { command: 'bing.request-indexing' },
    })
  }

  const result = await client.bingRequestIndexing(project, body) as {
    summary: { total: number; succeeded: number; failed: number }
    results: Array<{ url: string; status: string; submittedAt: string; error?: string }>
  }

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  for (const r of result.results) {
    if (r.status === 'success') {
      console.log(`Submitted to Bing: ${r.url}`)
      console.log(`  Submitted at: ${r.submittedAt}`)
      console.log()
    } else {
      console.error(`Failed: ${r.url}`)
      console.error(`  Error: ${r.error}`)
      console.log()
    }
  }

  if (result.results.length > 1) {
    console.log(`Summary: ${result.summary.succeeded} succeeded, ${result.summary.failed} failed (${result.summary.total} total)`)
  }
}

export async function bingInspectSitemap(project: string, opts: {
  sitemapUrl?: string
  wait?: boolean
  format?: string
}): Promise<void> {
  const client = getClient()
  const run = await client.bingInspectSitemap(project, {
    sitemapUrl: opts.sitemapUrl,
  }) as { id: string; status: string; kind: string }

  if (!opts.wait && isMachineFormat(opts.format)) {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  if (!isMachineFormat(opts.format)) {
    console.log(`Bing sitemap inspection started (run ${run.id})`)
  }

  if (opts.wait) {
    const current = await waitForRunStatus(client, run.id, {
      timeoutMs: 30 * 60 * 1000,
      intervalMs: 3000,
      progressLabel: 'Waiting for Bing sitemap inspection to complete',
      successStatuses: ['completed', 'partial'],
      failureStatuses: ['failed'],
      timeoutCode: 'BING_INSPECT_SITEMAP_TIMEOUT',
      failureCode: 'BING_INSPECT_SITEMAP_FAILED',
      timeoutMessage: 'Timed out waiting for Bing sitemap inspection to complete.',
      failureMessage: 'Bing sitemap inspection failed.',
      details: { project },
    })

    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify(current, null, 2))
      return
    }

    if (current.status === 'partial') {
      console.log('Bing sitemap inspection completed with some errors.')
      return
    }

    console.log('Bing sitemap inspection completed successfully.')
  }
}

export async function bingPerformance(project: string, format?: string): Promise<void> {
  const client = getClient()
  const rows = await client.bingPerformance(project) as Array<{
    query: string
    impressions: number
    clicks: number
    ctr: number
    averagePosition: number
  }>

  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2))
    return
  } else if (format === 'jsonl') {
    // Emit every row (no 50-row human truncation) — agents read the full set.
    emitJsonl(rows.map((row) => ({ project, ...row })))
    return
  }

  if (rows.length === 0) {
    console.log('No Bing performance data found.')
    return
  }

  console.log(`Bing search performance (${rows.length} keywords):\n`)
  console.log(`  ${'QUERY'.padEnd(40)}${'CLICKS'.padEnd(8)}${'IMPR'.padEnd(8)}${'CTR'.padEnd(8)}${'POS'.padEnd(6)}`)
  console.log(`  ${'─'.repeat(40)}${'─'.repeat(8)}${'─'.repeat(8)}${'─'.repeat(8)}${'─'.repeat(6)}`)
  for (const row of rows.slice(0, 50)) {
    const query = row.query.length > 38 ? row.query.slice(0, 35) + '...' : row.query
    console.log(
      `  ${query.padEnd(40)}${String(row.clicks).padEnd(8)}${String(row.impressions).padEnd(8)}${formatPercent(row.ctr).padStart(6)}  ${row.averagePosition.toFixed(1).padStart(5)}`,
    )
  }
  if (rows.length > 50) {
    console.log(`\n  ... and ${rows.length - 50} more rows (use --format json for full output)`)
  }
}

// ── Full Bing data: stored reads, live drill-downs, keyword research ────────

function pad(value: string | number, width: number): string {
  const text = String(value)
  return text.length > width - 1 ? `${text.slice(0, width - 4)}...`.padEnd(width) : text.padEnd(width)
}

function position(value: number | null): string {
  return value === null ? '-' : value.toFixed(1)
}

function windowLabel(window: { startDate: string | null; endDate: string | null }): string {
  return window.startDate && window.endDate ? `${window.startDate} to ${window.endDate}` : 'no stored data yet'
}

function printJson(format: string | undefined, payload: unknown, jsonlRows?: unknown[]): boolean {
  if (format === 'json') {
    console.log(JSON.stringify(payload, null, 2))
    return true
  }
  if (format === 'jsonl') {
    emitJsonl(jsonlRows ?? [payload])
    return true
  }
  return false
}

export async function bingSubmitSitemap(project: string, sitemapUrl: string, opts: { format?: string }): Promise<void> {
  const result = await getClient().bingSubmitSitemap(project, sitemapUrl)
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Bing accepted ${result.sitemapUrl}. A new sitemap shows in "canonry sitemaps ${project}" after the next Bing sync.`)
}

export async function bingSync(project: string, opts: { wait?: boolean; format?: string }): Promise<void> {
  const client = getClient()
  const run = await client.bingSync(project)
  if (!opts.wait) {
    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify(run, null, 2))
      return
    }
    console.log(`Bing data sync started (run ${run.id}). Check it with "canonry runs get ${run.id}".`)
    return
  }
  const current = await waitForRunStatus(client, run.id, {
    timeoutMs: 30 * 60 * 1000,
    intervalMs: 3000,
    progressLabel: 'Waiting for the Bing data sync',
    successStatuses: ['completed', 'partial'],
    failureStatuses: ['failed'],
    timeoutCode: 'BING_SYNC_TIMEOUT',
    failureCode: 'BING_SYNC_FAILED',
    timeoutMessage: 'Timed out waiting for the Bing data sync to finish.',
    failureMessage: 'The Bing data sync failed.',
    details: { project },
  })
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(current, null, 2))
    return
  }
  console.log(current.status === 'partial'
    ? `Bing data sync finished with some sections missing: ${current.error ? formatRunErrorOneLine(current.error) : 'see the run for details'}`
    : 'Bing data sync completed.')
}

type BingWindowOption = '7d' | '30d' | '90d' | 'all'

/** `--window` as the API spells it; anything else is left for the API to reject with its own message. */
function windowOption(value: string | undefined): BingWindowOption | undefined {
  return value === undefined ? undefined : value as BingWindowOption
}

/** One line per metric: the change against the comparison period, as the API computed it. */
function trafficComparisonLines(comparison: BingTrafficResponseDto['periodComparison']): string[] {
  if (!comparison) return ['  No comparison period.']
  const basis = comparison.basis === 'split-window'
    ? `last ${comparison.days} days vs the ${comparison.days} days before, inside this window`
    : `vs prior ${comparison.days} days`
  const pct = (ratio: number | null) => (ratio === null ? 'n/a' : `${ratio >= 0 ? '+' : ''}${formatPercent(ratio)}`)
  return [
    `  Change, ${basis}:`,
    `    clicks ${pct(comparison.change.clicks)} (${comparison.prior.clicks} -> ${comparison.trailing.clicks})`,
    `    impressions ${pct(comparison.change.impressions)} (${comparison.prior.impressions} -> ${comparison.trailing.impressions})`,
  ]
}

export async function bingTraffic(project: string, opts: { startDate?: string; endDate?: string; days?: string; window?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingTraffic(project, { startDate: opts.startDate, endDate: opts.endDate, days: opts.days, window: windowOption(opts.window) })
  if (printJson(opts.format, result, result.rows.map((row) => ({ project, ...row })))) return
  if (result.rows.length === 0) {
    console.log('No stored Bing traffic. Run "canonry bing sync <project>" first.')
    return
  }
  console.log(`Bing search traffic, ${windowLabel(result.window)}: ${result.totals.clicks} clicks, ${result.totals.impressions} impressions, ${formatPercent(result.totals.ctr)} CTR`)
  for (const line of trafficComparisonLines(result.periodComparison)) console.log(line)
  console.log('')
  console.log(`  ${pad('DATE', 12)}${pad('CLICKS', 9)}${pad('IMPR', 10)}CTR`)
  for (const row of result.rows) {
    console.log(`  ${pad(row.date, 12)}${pad(row.clicks, 9)}${pad(row.impressions, 10)}${formatPercent(row.ctr)}`)
  }
}

export async function bingQueries(project: string, opts: {
  startDate?: string; endDate?: string; days?: string; window?: string; query?: string; exact?: boolean; groupBy?: string; limit?: number; offset?: number; format?: string
}): Promise<void> {
  const client = getClient()
  const result = await client.bingQueries(project, {
    startDate: opts.startDate, endDate: opts.endDate, days: opts.days, window: windowOption(opts.window),
    query: opts.query, match: opts.exact ? 'exact' : undefined, groupBy: opts.groupBy, limit: opts.limit, offset: opts.offset,
  })
  const rows = result.groupBy === 'week' ? result.weekly : result.rows
  if (printJson(opts.format, result, rows.map((row) => ({ project, ...row })))) return
  printWeeklyTable('query', result.groupBy, result.rows.map(({ query, ...rest }) => ({ key: query, ...rest })), result.weekly, result)
}

export async function bingPages(project: string, opts: {
  startDate?: string; endDate?: string; days?: string; window?: string; page?: string; exact?: boolean; groupBy?: string; limit?: number; offset?: number; format?: string
}): Promise<void> {
  const client = getClient()
  const result = await client.bingPages(project, {
    startDate: opts.startDate, endDate: opts.endDate, days: opts.days, window: windowOption(opts.window),
    page: opts.page, match: opts.exact ? 'exact' : undefined, groupBy: opts.groupBy, limit: opts.limit, offset: opts.offset,
  })
  const rows = result.groupBy === 'week' ? result.weekly : result.rows
  if (printJson(opts.format, result, rows.map((row) => ({ project, ...row })))) return
  printWeeklyTable('page', result.groupBy, result.rows.map(({ page, ...rest }) => ({ key: page, ...rest })), result.weekly, result)
}

interface WeeklyTotals { clicks: number; impressions: number; ctr: number; avgImpressionPosition: number | null; weeks: number }

function printWeeklyTable(
  noun: 'query' | 'page',
  groupBy: string,
  keyed: Array<WeeklyTotals & { key: string }>,
  weekly: Array<WeeklyTotals & { date: string }>,
  meta: {
    totalMatching: number
    truncated: boolean
    window: { startDate: string | null; endDate: string | null }
    totals: WeeklyTotals | null
    comparison: BingSearchComparisonDto | null
  },
): void {
  if (groupBy === 'week') {
    if (weekly.length === 0) {
      console.log('No stored Bing stats for this window. Run "canonry bing sync <project>" first.')
      return
    }
    console.log(`Bing ${noun} stats by week, ${windowLabel(meta.window)}:\n`)
    console.log(`  ${pad('WEEK', 12)}${pad('CLICKS', 9)}${pad('IMPR', 10)}${pad('CTR', 9)}POS`)
    for (const row of weekly) {
      console.log(`  ${pad(row.date, 12)}${pad(row.clicks, 9)}${pad(row.impressions, 10)}${pad(formatPercent(row.ctr), 9)}${position(row.avgImpressionPosition)}`)
    }
    return
  }
  if (keyed.length === 0) {
    console.log('No stored Bing stats for this window. Run "canonry bing sync <project>" first.')
    return
  }
  const width = noun === 'page' ? 60 : 42
  console.log(`Bing ${noun} stats, ${windowLabel(meta.window)} (${meta.totalMatching} ${noun === 'page' ? 'pages' : 'queries'}; Bing reports these per week):`)
  if (meta.totals) {
    console.log(`  All matching: ${meta.totals.clicks} clicks, ${meta.totals.impressions} impressions, position ${position(meta.totals.avgImpressionPosition)}`)
  }
  if (meta.comparison) {
    const change = meta.comparison.difference
    const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`
    console.log(`  vs prior ${meta.comparison.days} days: clicks ${signed(change.clicks)}, impressions ${signed(change.impressions)}, position ${change.avgImpressionPosition === null ? 'n/a' : signed(change.avgImpressionPosition)}`)
  }
  console.log('')
  console.log(`  ${pad(noun.toUpperCase(), width)}${pad('CLICKS', 9)}${pad('IMPR', 10)}${pad('CTR', 9)}${pad('POS', 7)}WEEKS`)
  for (const row of keyed) {
    console.log(`  ${pad(row.key, width)}${pad(row.clicks, 9)}${pad(row.impressions, 10)}${pad(formatPercent(row.ctr), 9)}${pad(position(row.avgImpressionPosition), 7)}${row.weeks}`)
  }
  if (meta.truncated) console.log(`\n  More rows follow; page with --offset, or use --format json.`)
}

export async function bingCrawlStats(project: string, opts: { startDate?: string; endDate?: string; days?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingCrawlStats(project, { startDate: opts.startDate, endDate: opts.endDate, days: opts.days })
  if (printJson(opts.format, result, result.rows.map((row) => ({ project, ...row })))) return
  if (result.rows.length === 0) {
    console.log('No stored Bing crawl stats. Run "canonry bing sync <project>" first.')
    return
  }
  console.log(`Bingbot crawl stats, ${windowLabel(result.window)}:\n`)
  console.log(`  ${pad('DATE', 12)}${pad('CRAWLED', 9)}${pad('INDEXED', 9)}${pad('ERRORS', 8)}${pad('2XX', 6)}${pad('301', 6)}${pad('4XX', 6)}${pad('5XX', 6)}ROBOTS`)
  for (const row of result.rows) {
    console.log(`  ${pad(row.date, 12)}${pad(row.crawledPages, 9)}${pad(row.inIndex, 9)}${pad(row.crawlErrors, 8)}${pad(row.code2xx, 6)}${pad(row.code301, 6)}${pad(row.code4xx, 6)}${pad(row.code5xx, 6)}${row.blockedByRobotsTxt}`)
  }
}

export async function bingSitemaps(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.bingSitemaps(project)
  if (printJson(format, result, result.sitemaps.map((row) => ({ project, ...row })))) return
  if (result.sitemaps.length === 0) {
    console.log('Bing has no sitemaps stored for this project. Run "canonry bing sync <project>", or submit one in Bing Webmaster Tools.')
    return
  }
  console.log(`Bing sitemaps (as of ${result.syncedAt}):\n`)
  for (const row of result.sitemaps) {
    const indent = row.parentUrl ? '    ' : '  '
    console.log(`${indent}${row.url}`)
    console.log(`${indent}  ${row.type}, ${row.status}, ${row.urlCount} URLs, last crawled ${row.lastCrawledAt ?? 'never'}`)
  }
}

function describeSnapshot(kind: string, payload: unknown): string {
  if (payload === null || payload === undefined) return 'no data'
  if (Array.isArray(payload)) return payload.length === 0 ? 'none' : `${payload.length} item(s)`
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (kind.endsWith('submission-quota')) return `${String(record.dailyQuota)} left today, ${String(record.monthlyQuota)} left this month`
    if (kind === 'crawl-settings') {
      const rates = Array.isArray(record.crawlRate) ? (record.crawlRate as number[]) : []
      return `crawl boost ${record.crawlBoostEnabled ? 'on' : 'off'}${record.crawlBoostAvailable ? '' : ' (not available)'}, hourly rate ${rates.length ? `${Math.min(...rates)} to ${Math.max(...rates)}` : 'unknown'}`
    }
  }
  return JSON.stringify(payload)
}

export async function bingSite(project: string, opts: { kind?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingSite(project, { kind: opts.kind })
  if (printJson(opts.format, result, result.snapshots.map((row) => ({ project, ...row })))) return
  if (result.snapshots.length === 0) {
    console.log('No stored Bing site settings. Run "canonry bing sync <project>" first.')
    return
  }
  console.log(`Bing site settings (as of ${result.syncedAt}):\n`)
  for (const snap of result.snapshots) {
    const state = snap.status === 'ok' ? describeSnapshot(snap.kind, snap.payload) : snap.status === 'unauthorized' ? 'not readable with this key (owner-only)' : `could not be read: ${snap.error ?? 'unknown error'}`
    console.log(`  ${pad(snap.kind, 27)}${state}`)
    if (snap.status === 'ok' && Array.isArray(snap.payload)) {
      for (const item of snap.payload.slice(0, 10)) console.log(`    ${JSON.stringify(item)}`)
    }
  }
}

export async function bingKeywordDemand(project: string, opts: { query?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingKeywordDemand(project, { query: opts.query })
  if (printJson(opts.format, result, (opts.query ? result.history : result.rows).map((row) => ({ project, ...row })))) return
  if (opts.query) {
    if (result.history.length === 0) {
      console.log(`No stored Bing demand for "${opts.query}". It is read during "canonry bing sync" for tracked queries.`)
      return
    }
    console.log(`Weekly Bing searches for "${opts.query}" (${result.market.country}, ${result.market.language}):\n`)
    console.log(`  ${pad('WEEK', 12)}${pad('EXACT', 9)}BROAD`)
    for (const week of result.history) console.log(`  ${pad(week.date, 12)}${pad(week.impressions, 9)}${week.broadImpressions}`)
    return
  }
  if (result.rows.length === 0) {
    console.log('No tracked queries.')
    return
  }
  console.log(`Bing search demand for tracked queries (${result.market.country}, ${result.market.language}; exact-match searches per week):\n`)
  console.log(`  ${pad('QUERY', 46)}${pad('AVG/WK', 9)}${pad('LATEST', 9)}WEEKS`)
  for (const row of result.rows) {
    console.log(`  ${pad(row.query, 46)}${pad(row.avgWeeklyImpressions ?? '-', 9)}${pad(row.latestImpressions ?? '-', 9)}${row.weeks}`)
  }
}

export async function bingQueryPages(project: string, searchQuery: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.bingQueryPages(project, searchQuery)
  if (printJson(format, result, result.rows.map((row) => ({ project, query: searchQuery, ...row })))) return
  printStatsRows(`Pages Bing showed for "${searchQuery}" (per week, live from Bing):`, 'PAGE', result.rows)
}

export async function bingPageQueries(project: string, page: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.bingPageQueries(project, page)
  if (printJson(format, result, result.rows.map((row) => ({ project, page, ...row })))) return
  printStatsRows(`Queries ${page} showed for on Bing (per week, live from Bing):`, 'QUERY', result.rows)
}

function printStatsRows(title: string, keyLabel: string, rows: Array<{ date: string | null; key: string; clicks: number; impressions: number; ctr: number; avgImpressionPosition: number | null }>): void {
  if (rows.length === 0) {
    console.log('Bing returned no rows.')
    return
  }
  console.log(`${title}\n`)
  console.log(`  ${pad('WEEK', 12)}${pad(keyLabel, 52)}${pad('CLICKS', 9)}${pad('IMPR', 9)}POS`)
  for (const row of rows) {
    console.log(`  ${pad(row.date ?? '-', 12)}${pad(row.key, 52)}${pad(row.clicks, 9)}${pad(row.impressions, 9)}${position(row.avgImpressionPosition)}`)
  }
}

export async function bingQueryHistory(project: string, opts: { query: string; page?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingQueryHistory(project, { query: opts.query, page: opts.page })
  if (printJson(opts.format, result, result.rows.map((row) => ({ project, query: opts.query, page: opts.page ?? null, ...row })))) return
  if (result.rows.length === 0) {
    console.log('Bing returned no rows.')
    return
  }
  console.log(`"${opts.query}"${opts.page ? ` on ${opts.page}` : ''} on Bing, per ${result.granularity} (live from Bing):\n`)
  console.log(`  ${pad(result.granularity.toUpperCase(), 12)}${pad('CLICKS', 9)}${pad('IMPR', 9)}${pad('CTR', 9)}POS`)
  for (const row of result.rows) {
    console.log(`  ${pad(row.date ?? '-', 12)}${pad(row.clicks, 9)}${pad(row.impressions, 9)}${pad(formatPercent(row.ctr), 9)}${position(row.position)}`)
  }
}

export async function bingUrlTraffic(project: string, opts: { url: string; children?: boolean; page?: number; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingUrlTraffic(project, { url: opts.url, children: opts.children ? 'true' : undefined, page: opts.page === undefined ? undefined : String(opts.page) })
  if (printJson(opts.format, result, [result.url, ...result.children].map((row) => ({ project, ...row })))) return
  console.log(`${result.url.url}: ${result.url.clicks} clicks, ${result.url.impressions} impressions on Bing`)
  if (opts.children) {
    if (result.children.length === 0) console.log('  Bing listed no URLs under it.')
    for (const child of result.children) console.log(`  ${pad(child.url, 70)}${pad(child.clicks, 9)}${child.impressions}`)
  }
}

export async function bingUrlChildren(project: string, opts: { url: string; page?: number; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingUrlChildren(project, { url: opts.url, page: opts.page === undefined ? undefined : String(opts.page) })
  if (printJson(opts.format, result, result.rows.map((row) => ({ project, ...row })))) return
  if (result.rows.length === 0) {
    console.log('Bing listed no URLs under this one.')
    return
  }
  for (const row of result.rows) {
    console.log(`  ${pad(row.url, 70)}HTTP ${row.httpStatus ?? '-'}, last crawled ${row.lastCrawledDate ?? 'never'}`)
  }
}

export async function bingLinks(project: string, opts: { url?: string; page?: number; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingLinks(project, { url: opts.url, page: opts.page === undefined ? undefined : String(opts.page) })
  if (printJson(opts.format, result, result.rows.map((row) => ({ project, ...row })))) return
  if (result.rows.length === 0) {
    console.log('Bing reported no inbound links. Bing often returns none for smaller sites; Common Crawl backlinks ("canonry backlinks") cover more.')
    return
  }
  console.log(opts.url ? `External pages linking to ${opts.url} (page ${result.page + 1} of ${result.totalPages}):\n` : `Pages with inbound links (page ${result.page + 1} of ${result.totalPages}):\n`)
  for (const row of result.rows) {
    console.log(opts.url ? `  ${row.url}${row.anchorText ? `  "${row.anchorText}"` : ''}` : `  ${pad(row.url, 70)}${row.count ?? '-'}`)
  }
}

export async function bingFetchedUrls(project: string, opts: { url?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingFetchedUrls(project, { url: opts.url })
  if (printJson(opts.format, result, opts.url ? [result.details] : result.rows.map((row) => ({ project, ...row })))) return
  if (opts.url) {
    if (!result.details) {
      console.log('Bing has no Fetch as Bingbot result for this URL.')
      return
    }
    console.log(`${result.details.url}: ${result.details.status ?? 'unknown status'} (${result.details.date ?? 'no date'})`)
    if (result.details.headers) console.log(`\n${result.details.headers}`)
    return
  }
  if (result.rows.length === 0) {
    console.log('No Fetch as Bingbot history.')
    return
  }
  for (const row of result.rows) console.log(`  ${pad(row.url, 70)}${row.date ?? '-'}${row.fetched === false ? ' (pending)' : ''}`)
}

export async function bingKeywords(project: string, opts: { keyword: string; country?: string; language?: string; startDate?: string; endDate?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.bingKeywords(project, opts)
  if (printJson(opts.format, result, result.related.map((row) => ({ project, keyword: opts.keyword, ...row })))) return
  console.log(`"${result.keyword}" on Bing (${result.market.country}, ${result.market.language}), ${result.window.startDate} to ${result.window.endDate}:`)
  console.log(result.volume ? `  ${result.volume.impressions} exact-match searches, ${result.volume.broadImpressions} broad-match` : '  Bing has no volume for this keyword.')
  if (result.history.length > 0) {
    const recent = result.history.slice(-8)
    console.log(`\n  Weekly exact-match searches (last ${recent.length} weeks): ${recent.map((week) => week.impressions).join(', ')}`)
  }
  if (result.related.length > 0) {
    console.log(`\n  ${pad('RELATED KEYWORD', 46)}${pad('EXACT', 9)}BROAD`)
    for (const row of result.related.slice(0, 25)) console.log(`  ${pad(row.query, 46)}${pad(row.impressions, 9)}${row.broadImpressions}`)
  }
}
