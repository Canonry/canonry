import type {
  GscPerformanceDailyDto,
  GscSubmitSitemapsResponseDto,
  GscUrlInspectionDto,
  IndexingRequestResultDto,
} from '@ainyc/canonry-contracts'
import { type ApiClient, createApiClient } from '../client.js'
import { CliError, EXIT_SYSTEM_ERROR, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'
import { describeError, formatPercent } from '@ainyc/canonry-contracts'

const INDEXING_API_SCOPE_NOTICE =
  "Note: Google's Indexing API officially supports only pages with JobPosting or BroadcastEvent (livestream VideoObject) structured data. " +
  'Other URL types are outside the supported use of that API. ' +
  'For general pages, submit a sitemap and use URL Inspection to monitor status.'

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
): Promise<{ status: string }> {
  const start = Date.now()
  process.stderr.write(config.progressLabel)

  while (Date.now() - start < config.timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs))
    const current = await client.getRun(runId) as { status: string }
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
        details: {
          runId,
          status: current.status,
          ...(config.details ?? {}),
        },
      })
    }
  }

  process.stderr.write('\n')
  throw new CliError({
    code: config.timeoutCode,
    message: config.timeoutMessage,
    displayMessage: config.timeoutMessage,
    details: {
      runId,
      ...(config.details ?? {}),
    },
  })
}

export async function googleConnect(project: string, opts: { type: string; publicUrl?: string; format?: string }): Promise<void> {
  const client = getClient()
  const { authUrl, redirectUri } = await client.googleConnect(project, {
    type: opts.type,
    publicUrl: opts.publicUrl,
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify({
      project,
      type: opts.type,
      authUrl,
      redirectUri: redirectUri ?? null,
    }, null, 2))
    return
  }

  console.log(`\nOpen this URL in your browser to authorize Google ${opts.type.toUpperCase()} access:\n`)
  console.log(`  ${authUrl}\n`)

  if (redirectUri) {
    console.log(`Redirect URI: ${redirectUri}`)
    console.log('(Ensure this URI is listed in your Google Cloud Console OAuth client\'s authorized redirect URIs)\n')
  }

  // Try to open browser automatically
  try {
    const { spawn } = await import('node:child_process')
    const platform = process.platform
    const [cmd, ...extraArgs] = platform === 'darwin'
      ? ['open', authUrl]
      : platform === 'win32'
        ? ['cmd', '/c', 'start', '', authUrl]
        : ['xdg-open', authUrl]
    spawn(cmd!, [...extraArgs], { detached: true, stdio: 'ignore' }).unref()
    console.log('(Browser opened automatically)')
  } catch {
    console.log('(Could not open browser automatically — please copy the URL above)')
  }
}

export async function googleDisconnect(project: string, opts: { type: string; format?: string }): Promise<void> {
  const client = getClient()
  await client.googleDisconnect(project, opts.type)

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify({ project, type: opts.type, disconnected: true }, null, 2))
    return
  }

  console.log(`Disconnected Google ${opts.type.toUpperCase()} from project "${project}".`)
}

export async function googleStatus(project: string, format?: string): Promise<void> {
  const client = getClient()
  const connections = await client.googleConnections(project) as Array<{
    connectionType: string
    propertyId?: string | null
    scopes: string[]
    createdAt: string
    updatedAt: string
  }>

  if (format === 'json') {
    console.log(JSON.stringify({ connections }, null, 2))
    return
  } else if (format === 'jsonl') {
    emitJsonl(connections.map((conn) => ({ project, ...conn })))
    return
  }

  if (connections.length === 0) {
    console.log(`No Google connections for project "${project}".`)
    console.log('Run "canonry google connect <project> --type gsc" to connect.')
    return
  }

  console.log(`Google connections for "${project}":\n`)
  for (const conn of connections) {
    const type = conn.connectionType.toUpperCase()
    const property = conn.propertyId ?? '(not set)'
    console.log(`  ${type}`)
    console.log(`    Property:   ${property}`)
    console.log(`    Connected:  ${conn.createdAt}`)
    console.log(`    Updated:    ${conn.updatedAt}`)
    console.log()
  }
}

export async function googleProperties(project: string, format?: string): Promise<void> {
  const client = getClient()
  const { sites } = await client.googleProperties(project)

  if (format === 'json') {
    console.log(JSON.stringify({ sites }, null, 2))
    return
  } else if (format === 'jsonl') {
    emitJsonl(sites.map((site) => ({ project, ...site })))
    return
  }

  if (sites.length === 0) {
    console.log('No verified sites found for this Google account.')
    return
  }

  console.log('Available GSC properties:\n')
  const urlWidth = Math.max(10, ...sites.map((s) => s.siteUrl.length))
  console.log(`  ${'SITE URL'.padEnd(urlWidth)}  PERMISSION`)
  console.log(`  ${'─'.repeat(urlWidth)}  ${'─'.repeat(12)}`)
  for (const site of sites) {
    console.log(`  ${site.siteUrl.padEnd(urlWidth)}  ${site.permissionLevel}`)
  }
  console.log(`\nUse "canonry google set-property <project> <siteUrl>" to select a property.`)
}

export async function googleSetProperty(project: string, propertyUrl: string, format?: string): Promise<void> {
  const client = getClient()
  await client.googleSetProperty(project, 'gsc', propertyUrl)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, type: 'gsc', propertyUrl }, null, 2))
    return
  }

  console.log(`GSC property set to "${propertyUrl}" for project "${project}".`)
}

export async function googleSync(project: string, opts: {
  type?: string
  days?: number
  full?: boolean
  wait?: boolean
  format?: string
}): Promise<void> {
  const client = getClient()
  const run = await client.gscSync(project, { days: opts.days, full: opts.full }) as {
    id: string
    status: string
    kind: string
  }

  if (!opts.wait && isMachineFormat(opts.format)) {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  if (!isMachineFormat(opts.format)) {
    console.log(`GSC sync started (run ${run.id})`)
  }

  if (opts.wait) {
    const current = await waitForRunStatus(client, run.id, {
      timeoutMs: 10 * 60 * 1000,
      intervalMs: 2000,
      progressLabel: 'Waiting for sync to complete',
      successStatuses: ['completed'],
      failureStatuses: ['failed'],
      timeoutCode: 'GOOGLE_SYNC_TIMEOUT',
      failureCode: 'GOOGLE_SYNC_FAILED',
      timeoutMessage: 'Timed out waiting for GSC sync to complete.',
      failureMessage: 'GSC sync failed.',
      details: { project },
    })

    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify({ ...run, status: current.status }, null, 2))
      return
    }

    console.log('GSC sync completed successfully.')
  }
}

export async function googlePerformanceDaily(project: string, opts: {
  window?: string
  startDate?: string
  endDate?: string
  format?: string
}): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  if (opts.window) params.window = opts.window
  if (opts.startDate) params.startDate = opts.startDate
  if (opts.endDate) params.endDate = opts.endDate

  const data = await client.gscPerformanceDaily(project, Object.keys(params).length > 0 ? params : undefined)

  if (opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  } else if (opts.format === 'jsonl') {
    // Carry the envelope's window onto every record — a bare daily row cannot
    // say which period it belongs to or how fresh that period is.
    emitJsonl(data.daily.map((row) => ({ project, window: data.window, ...row })))
    return
  }

  if (data.daily.length === 0) {
    console.log('No GSC data found in this window. Run "canonry google sync" first.')
    return
  }

  const { clicks, impressions, ctr, position, days } = data.totals
  // Optional at RUNTIME even though the DTO requires it: a server older than
  // this field omits it, and a new CLI against an older server must degrade to
  // no range label rather than crash. The web guards the same skew.
  const win = data.window as GscPerformanceDailyDto['window'] | undefined
  const range = win?.startDate && win.endDate ? ` ${win.startDate} to ${win.endDate}` : ''
  console.log(`GSC daily summary (${days} day${days === 1 ? '' : 's'}${range}):\n`)
  // The window stops short of today by design. Say what it covers, or a short
  // window reads as a sudden drop in coverage.
  // Freshness describes the PROJECT's latest data, not the requested range, so
  // it may only be printed beside a range that actually ends there. Against an
  // explicit historical range it read as `2026-01-31 (2 days ago)`.
  const endsAtFrontier = win?.endDate !== undefined && win.endDate === win.latestDataDate
  if (endsAtFrontier && (win.daysSinceLatestData ?? 0) > 0) {
    console.log(`  Search Console data through ${win.endDate} (${win.daysSinceLatestData} day${win.daysSinceLatestData === 1 ? '' : 's'} ago).`)
    console.log()
  } else if (win?.latestDataDate && win.endDate !== win.latestDataDate) {
    console.log(`  Showing a fixed range. Latest Search Console data is ${win.latestDataDate}.`)
    console.log()
  }
  console.log(`  Clicks:      ${clicks.toLocaleString()}`)
  console.log(`  Impressions: ${impressions.toLocaleString()}`)
  console.log(`  CTR:         ${formatPercent(ctr)}`)
  console.log(`  Position:    ${position == null ? '—' : position.toFixed(1)}`)

  // The same fit the dashboard chart draws, so the two surfaces can never
  // disagree about which way a metric is going.
  // Optional at RUNTIME for the same reason as `window`: a server older than
  // the field omits it, and the CLI degrades to no trend block rather than
  // crashing.
  const fits = data.trends
  const trendLines: string[] = []
  for (const [label, trend, fmt] of [
    ['Clicks', fits?.clicks, (v: number) => v.toFixed(2)],
    ['Impressions', fits?.impressions, (v: number) => v.toFixed(2)],
    ['CTR', fits?.ctr, (v: number) => `${(v * 100).toFixed(3)}pp`],
    ['Position', fits?.position, (v: number) => v.toFixed(3)],
  ] as const) {
    if (!trend) continue
    // Position improves as it falls, so "up" is the wrong word for a rising rank.
    const better = label === 'Position' ? trend.slope < 0 : trend.slope > 0
    const direction = trend.slope === 0 ? 'flat' : better ? 'improving' : 'declining'
    trendLines.push(
      `  ${`${label}:`.padEnd(13)}${fmt(trend.slope).padStart(10)}/day  ${direction} (r²=${trend.r2.toFixed(2)})`,
    )
  }
  if (trendLines.length > 0) {
    console.log(`\nTrend (least-squares fit over ${days} day${days === 1 ? '' : 's'}):`)
    for (const line of trendLines) console.log(line)
  }

  // The percentages the dashboard tiles show. Printed here so the two surfaces
  // cannot disagree about how much a metric moved — the fit above says which
  // WAY it is going, this says by how much, and only this one has a baseline
  // the property actually recorded.
  //
  // Optional at RUNTIME for the same reason as `window`, and null when the
  // range is too short to split into two periods.
  const cmp = data.periodComparison
  if (cmp && !cmp.comparable) {
    // Any dimensioned fallback is invalid for property totals, even when both
    // halves happen to use it.
    console.log(
      `\nNo period comparison: period comparison needs property-level daily data.`
      + ` Sync again, or pick a range covered by property totals.`,
    )
  } else if (cmp) {
    const pct = (
      ratio: number | null,
      prior: number | null,
      trailing: number | null,
      inverted: boolean,
    ): string => {
      if (ratio === null) {
        if (prior !== null && trailing !== null && prior <= 0 && trailing > 0) {
          return `new in last ${cmp.days} day${cmp.days === 1 ? '' : 's'}`
        }
        if (prior === null || prior <= 0) return 'no prior period to compare'
        if (trailing === null) return `no value in last ${cmp.days} day${cmp.days === 1 ? '' : 's'}`
        return 'comparison unavailable'
      }
      if (ratio === 0) return 'no change'
      const better = inverted ? ratio < 0 : ratio > 0
      return `${ratio > 0 ? '+' : '-'}${formatPercent(Math.abs(ratio))}  ${better ? 'better' : 'worse'}`
    }
    console.log(
      `\nLast ${cmp.days} day${cmp.days === 1 ? '' : 's'} (${cmp.trailing.startDate} to ${cmp.trailing.endDate})`
      + ` vs prior ${cmp.days} (${cmp.prior.startDate} to ${cmp.prior.endDate}):`,
    )
    // Under `split-window` the two periods came out of the selected window
    // itself, so the length above is HALF the window that was asked for. The
    // dates already say so, but only to a reader who subtracts them; say it.
    //
    // Absent `basis` is a server older than the field. Every such server split
    // the window, but it did not claim that, so neither does this.
    if (cmp.basis === 'split-window') {
      console.log(
        `  (no equal-length period with synced data before this window, so it was split in two)`,
      )
    }
    for (const [label, ratio, prior, trailing, inverted] of [
      ['Clicks', cmp.change.clicks, cmp.prior.clicks, cmp.trailing.clicks, false],
      ['Impressions', cmp.change.impressions, cmp.prior.impressions, cmp.trailing.impressions, false],
      ['CTR', cmp.change.ctr, cmp.prior.ctr, cmp.trailing.ctr, false],
      ['Position', cmp.change.position, cmp.prior.position, cmp.trailing.position, true],
    ] as const) {
      console.log(`  ${`${label}:`.padEnd(13)}${pct(ratio, prior, trailing, inverted)}`)
    }
  }

  console.log()
  console.log(`  ${'DATE'.padEnd(12)}${'CLICKS'.padStart(10)}${'IMPR'.padStart(12)}${'CTR'.padStart(10)}${'POS'.padStart(9)}`)
  console.log(`  ${'─'.repeat(12)}${'─'.repeat(10)}${'─'.repeat(12)}${'─'.repeat(10)}${'─'.repeat(9)}`)
  for (const row of data.daily) {
    console.log(
      `  ${row.date.padEnd(12)}${row.clicks.toLocaleString().padStart(10)}${row.impressions.toLocaleString().padStart(12)}${formatPercent(row.ctr).padStart(10)}${(row.position == null ? '—' : row.position.toFixed(1)).padStart(9)}`,
    )
  }
}

export async function googleTopPages(project: string, opts: {
  window?: string
  startDate?: string
  endDate?: string
  limit?: number
  format?: string
}): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  if (opts.window) params.window = opts.window
  if (opts.startDate) params.startDate = opts.startDate
  if (opts.endDate) params.endDate = opts.endDate
  if (opts.limit) params.limit = String(opts.limit)

  const data = await client.gscTopPages(project, Object.keys(params).length > 0 ? params : undefined)

  if (opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  } else if (opts.format === 'jsonl') {
    emitJsonl(data.rows.map((row) => ({ project, ...row })))
    return
  }

  if (data.rows.length === 0) {
    console.log('No GSC page data found in this window. Run "canonry google sync" first.')
    return
  }

  console.log(`Top pages by clicks (${data.rows.length} page${data.rows.length === 1 ? '' : 's'}):\n`)
  const pageWidth = Math.min(60, Math.max(20, ...data.rows.map((row) => row.page.length)))
  console.log(`  ${'PAGE'.padEnd(pageWidth)}${'CLICKS'.padStart(10)}${'IMPR'.padStart(12)}${'CTR'.padStart(10)}`)
  console.log(`  ${'─'.repeat(pageWidth)}${'─'.repeat(10)}${'─'.repeat(12)}${'─'.repeat(10)}`)
  for (const row of data.rows) {
    const page = row.page.length > pageWidth ? row.page.slice(0, pageWidth - 3) + '...' : row.page
    console.log(
      `  ${page.padEnd(pageWidth)}${row.clicks.toLocaleString().padStart(10)}${row.impressions.toLocaleString().padStart(12)}${formatPercent(row.ctr).padStart(10)}`,
    )
  }

  console.log()
  if (data.totals) {
    const { clicks, impressions, ctr, days } = data.totals
    console.log(`Property total (${days} day${days === 1 ? '' : 's'}, source: ${data.totalsSource}):`)
    console.log(`  Clicks:      ${clicks.toLocaleString()}`)
    console.log(`  Impressions: ${impressions.toLocaleString()}`)
    console.log(`  CTR:         ${formatPercent(ctr)}`)
    console.log()
    console.log('  The page rows above are a ranking. They do not add up to this total:')
    console.log('  Google withholds rare queries and repeats an impression per page.')
  } else {
    console.log('Property total: not available for this window.')
    console.log('  Adding up the page rows would not give it. Run "canonry google sync" to fetch it.')
  }
}

export async function googlePerformance(project: string, opts: {
  days?: number
  startDate?: string
  endDate?: string
  keyword?: string
  page?: string
  limit?: number
  offset?: number
  orderBy?: string
  format?: string
}): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  // An explicit --start/--end window wins over the relative --days window.
  // The CLI rejects both being passed, so this is a precedence rule for the
  // programmatic callers, not a silent pick.
  if (opts.startDate || opts.endDate) {
    if (opts.startDate) params.startDate = opts.startDate
    if (opts.endDate) params.endDate = opts.endDate
  } else if (opts.days) {
    // Forward the SPAN, never client-computed dates. Deriving bounds here
    // pinned them to the UTC clock and sent them as explicit dates, which the
    // route honours over its own anchor — so `--days 30` skipped the
    // published-day anchoring entirely, could end a Pacific day in the future,
    // and spanned 31 inclusive dates for a 30-day request. The server resolves
    // the span against the same frontier every other window uses.
    params.days = String(opts.days)
  }
  if (opts.keyword) params.query = opts.keyword
  if (opts.page) params.page = opts.page
  if (opts.limit !== undefined) params.limit = String(opts.limit)
  if (opts.offset !== undefined) params.offset = String(opts.offset)
  if (opts.orderBy) params.orderBy = opts.orderBy

  const data = await client.gscPerformance(project, Object.keys(params).length > 0 ? params : undefined)
  const { rows, totalMatching, truncated, latestAvailableDate } = data

  if (opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  } else if (opts.format === 'jsonl') {
    emitJsonl(rows.map((row) => ({ project, ...row })))
    return
  }

  if (rows.length === 0) {
    const requestedEnd = params.endDate
    // Rows exist, this page just starts past the end of them. Neither the lag
    // message nor the sync message applies: the fix is a smaller offset.
    if (totalMatching > 0 && opts.offset !== undefined && opts.offset >= totalMatching) {
      console.log(
        `Offset ${opts.offset} is past the end of the result set (${totalMatching.toLocaleString()} matching rows). Lower --offset to page through them.`,
      )
      return
    }
    // The data exists, the window just sits past what GSC has reported. Saying
    // "run sync" here sends the operator to a command that cannot help.
    if (latestAvailableDate && requestedEnd && requestedEnd > latestAvailableDate) {
      console.log(
        `No GSC data through ${requestedEnd}. GSC reporting lag: the latest date this project holds is ${latestAvailableDate}. Syncing again will not backfill dates Google has not reported yet.`,
      )
      return
    }
    console.log('No GSC data found. Run "canonry google sync" first.')
    return
  }

  console.log(`GSC performance data (${rows.length} of ${totalMatching.toLocaleString()} matching rows):\n`)
  console.log(`  ${'DATE'.padEnd(12)}${'QUERY'.padEnd(30)}${'CLICKS'.padEnd(8)}${'IMPR'.padEnd(8)}${'CTR'.padEnd(8)}${'POS'.padEnd(6)}`)
  console.log(`  ${'─'.repeat(12)}${'─'.repeat(30)}${'─'.repeat(8)}${'─'.repeat(8)}${'─'.repeat(8)}${'─'.repeat(6)}`)
  for (const row of rows.slice(0, 50)) {
    const query = row.query.length > 28 ? row.query.slice(0, 25) + '...' : row.query
    console.log(
      `  ${row.date.padEnd(12)}${query.padEnd(30)}${String(row.clicks).padEnd(8)}${String(row.impressions).padEnd(8)}${formatPercent(row.ctr).padStart(6)}  ${row.position.toFixed(1).padStart(5)}`,
    )
  }
  if (rows.length > 50) {
    console.log(`\n  ... and ${rows.length - 50} more rows on this page (use --format json for full output)`)
  }
  if (truncated) {
    console.log('\n  This is one page. Use --limit / --offset to page through the rest, --order-by to change the ranking.')
  }
  if (latestAvailableDate) {
    console.log(`  Latest date held for this project: ${latestAvailableDate}`)
  }
}

export async function googleInspect(project: string, url: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.gscInspect(project, url) as {
    url: string
    indexingState?: string
    verdict?: string
    coverageState?: string
    pageFetchState?: string
    robotsTxtState?: string
    crawlTime?: string
    lastCrawlResult?: string
    isMobileFriendly?: boolean
    richResults?: string[]
    inspectedAt: string
  }

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`\nURL Inspection: ${result.url}\n`)
  console.log(`  Indexing State:    ${result.indexingState ?? 'unknown'}`)
  console.log(`  Verdict:           ${result.verdict ?? 'unknown'}`)
  console.log(`  Coverage:          ${result.coverageState ?? 'unknown'}`)
  console.log(`  Page Fetch:        ${result.pageFetchState ?? 'unknown'}`)
  console.log(`  Robots.txt:        ${result.robotsTxtState ?? 'unknown'}`)
  console.log(`  Last Crawled:      ${result.crawlTime ?? 'unknown'}`)
  console.log(`  Mobile Friendly:   ${result.isMobileFriendly === true ? 'Yes' : result.isMobileFriendly === false ? 'No' : 'unknown'}`)
  console.log(`  Rich Results:      ${result.richResults?.length ? result.richResults.join(', ') : 'none'}`)
  console.log(`  Inspected At:      ${result.inspectedAt}`)
}

export async function googleInspections(project: string, opts: { url?: string; format?: string }): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  if (opts.url) params.url = opts.url

  const rows = await client.gscInspections(project, Object.keys(params).length > 0 ? params : undefined) as Array<{
    id: string
    url: string
    indexingState?: string
    verdict?: string
    coverageState?: string
    isMobileFriendly?: boolean
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
    console.log('No URL inspections found.')
    return
  }

  console.log(`URL inspection history (${rows.length} records):\n`)
  const urlWidth = Math.min(50, Math.max(10, ...rows.map((r) => r.url.length)))
  console.log(`  ${'URL'.padEnd(urlWidth)}  ${'INDEXING'.padEnd(14)}${'VERDICT'.padEnd(10)}${'INSPECTED'.padEnd(22)}`)
  console.log(`  ${'─'.repeat(urlWidth)}  ${'─'.repeat(14)}${'─'.repeat(10)}${'─'.repeat(22)}`)
  for (const row of rows) {
    const url = row.url.length > urlWidth ? row.url.slice(0, urlWidth - 3) + '...' : row.url
    console.log(
      `  ${url.padEnd(urlWidth)}  ${(row.indexingState ?? 'unknown').padEnd(14)}${(row.verdict ?? '-').padEnd(10)}${row.inspectedAt}`,
    )
  }
}

export async function googleCoverage(project: string, format?: string): Promise<void> {
  const client = getClient()
  const result = await client.gscCoverage(project) as {
    summary: { total: number; indexed: number; notIndexed: number; deindexed: number; percentage: number }
    lastInspectedAt: string | null
    indexed: Array<{ url: string; indexingState: string | null; crawlTime: string | null }>
    notIndexed: Array<{ url: string; indexingState: string | null; coverageState: string | null }>
    deindexed: Array<{ url: string; previousState: string | null; currentState: string | null; transitionDate: string }>
  }

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const { summary } = result
  if (summary.total === 0) {
    console.log('No URL inspections found. Run "canonry google inspect-sitemap <project>" first.')
    return
  }

  const pctColor = summary.percentage >= 80 ? '\x1b[32m' : summary.percentage >= 50 ? '\x1b[33m' : '\x1b[31m'
  const reset = '\x1b[0m'

  console.log(`\nIndex Coverage for "${project}"\n`)
  console.log(`  SUMMARY: ${pctColor}${summary.indexed} / ${summary.total} pages indexed (${formatPercent(summary.percentage, 'percent')})${reset}\n`)

  if (result.indexed.length > 0) {
    console.log(`  INDEXED (${result.indexed.length}):`)
    for (const page of result.indexed) {
      const crawl = page.crawlTime ? ` (crawled: ${page.crawlTime.split('T')[0]})` : ''
      console.log(`    ${page.url}${crawl}`)
    }
    console.log()
  }

  if (result.notIndexed.length > 0) {
    console.log(`  NOT INDEXED (${result.notIndexed.length}):`)
    for (const page of result.notIndexed) {
      const reason = page.coverageState ? ` — ${page.coverageState}` : ''
      console.log(`    ${page.url}${reason}`)
    }
    console.log()
  }

  if (result.deindexed.length > 0) {
    console.log(`  DEINDEXED (${result.deindexed.length}):`)
    for (const page of result.deindexed) {
      console.log(`    ${page.url}  (${page.previousState} -> ${page.currentState})`)
    }
    console.log()
  }

  if (result.lastInspectedAt) {
    console.log(`  Last inspected: ${result.lastInspectedAt}`)
  }
}

export async function googleSetSitemap(project: string, sitemapUrl: string, format?: string): Promise<void> {
  const client = getClient()
  await client.googleSetSitemap(project, 'gsc', sitemapUrl)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({ project, type: 'gsc', sitemapUrl }, null, 2))
    return
  }

  console.log(`GSC sitemap URL set to "${sitemapUrl}" for project "${project}".`)
}

export async function googleListSitemaps(project: string, opts: { format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.gscSitemaps(project) as {
    sitemaps: Array<{
      path: string
      lastSubmitted?: string
      isSitemapsIndex?: boolean
      contents?: Array<{ type: string; submitted: string }>
      warnings?: string
      errors?: string
    }>
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  } else if (opts.format === 'jsonl') {
    emitJsonl(result.sitemaps.map((s) => ({ project, ...s })))
    return
  }

  if (result.sitemaps.length === 0) {
    console.log(
      `No sitemaps found for project "${project}". ` +
      `Run "canonry google submit-sitemap ${project} <url>" to submit one.`,
    )
    return
  }

  console.log(`\nSitemaps for project "${project}":\n`)
  for (const s of result.sitemaps) {
    const submitted = sitemapSubmittedUrlTotal(s.contents)
    const isIndex = s.isSitemapsIndex ? ' [index]' : ''
    console.log(`  ${s.path}${isIndex}`)
    console.log(`    Submitted URLs: ${submitted}  |  Last submitted: ${s.lastSubmitted ?? 'unknown'}`)
  }
}

function sitemapSubmittedUrlTotal(contents: Array<{ submitted: string }> | undefined): number | '?' {
  if (!contents?.length) return '?'
  return contents.reduce((total, content) => total + (Number.parseInt(content.submitted, 10) || 0), 0)
}

function dedupeSitemapUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))]
}

export type GscSitemapSubmissionOptions = {
  sitemapUrls?: string[]
  configured?: boolean
  all?: boolean
  allFiles?: boolean
  onProgress?: (completedBatches: number, totalBatches: number) => void
}

export async function submitGscSitemaps(
  client: ApiClient,
  project: string,
  opts: GscSitemapSubmissionOptions,
): Promise<GscSubmitSitemapsResponseDto> {
  const explicitUrls = dedupeSitemapUrls(opts.sitemapUrls ?? [])
  const modes = Number(explicitUrls.length > 0) + Number(Boolean(opts.configured)) + Number(Boolean(opts.all)) + Number(Boolean(opts.allFiles))
  if (modes !== 1) {
    throw new CliError({
      code: 'CLI_USAGE_ERROR',
      message: 'provide sitemap URL(s), --configured, --all, or --all-files (exactly one)',
      displayMessage: 'Error: provide sitemap URL(s), --configured, --all, or --all-files (exactly one)',
      details: { command: 'google.submit-sitemap' },
    })
  }
  if (explicitUrls.length > 50) {
    throw new CliError({
      code: 'CLI_USAGE_ERROR',
      message: 'explicit sitemap URL submissions support at most 50 URLs; split the URLs into groups of 50 or use --all/--all-files for discovered sitemaps',
      displayMessage: 'Error: explicit sitemap URL submissions support at most 50 URLs; split the URLs into groups of 50 or use --all/--all-files for discovered sitemaps',
      details: { command: 'google.submit-sitemap', sitemapUrls: explicitUrls.length, maxSitemapUrls: 50 },
    })
  }

  let sitemapUrls = explicitUrls
  if (opts.configured) {
    const connections = await client.googleConnections(project)
    const sitemapUrl = connections.find((connection) => connection.connectionType === 'gsc')?.sitemapUrl
    if (!sitemapUrl || !sitemapUrl.trim()) {
      throw new CliError({
        code: 'CLI_USAGE_ERROR',
        message: 'no configured GSC sitemap URL found; use a URL, --all, or --all-files',
        displayMessage: 'Error: no configured GSC sitemap URL found; use a URL, --all, or --all-files',
        details: { command: 'google.submit-sitemap', project },
      })
    }
    sitemapUrls = dedupeSitemapUrls([sitemapUrl])
  } else if (opts.all || opts.allFiles) {
    const topLevel = await client.gscSitemaps(project)
    if (opts.all) {
      sitemapUrls = dedupeSitemapUrls(
        topLevel.preferredSubmissionUrls.length > 0
          ? topLevel.preferredSubmissionUrls
          : topLevel.sitemaps.map((sitemap) => sitemap.path),
      )
    } else if (opts.allFiles) {
      const indexes = topLevel.sitemaps.filter((sitemap) => sitemap.isSitemapsIndex).map((sitemap) => sitemap.path)
      const children = []
      for (let offset = 0; offset < indexes.length; offset += 4) {
        children.push(...await Promise.all(
          indexes.slice(offset, offset + 4).map((sitemapIndex) => client.gscSitemaps(project, { sitemapIndex })),
        ))
      }
      const expandedIndexUrls = children.flatMap((result, index) =>
        result.sitemaps.length > 0
          ? result.sitemaps.map((sitemap) => sitemap.path)
          : [indexes[index]!],
      )
      sitemapUrls = dedupeSitemapUrls([
        ...topLevel.sitemaps.filter((sitemap) => !sitemap.isSitemapsIndex).map((sitemap) => sitemap.path),
        ...expandedIndexUrls,
      ])
    }
    if (sitemapUrls.length === 0) {
      throw new CliError({
        code: 'CLI_USAGE_ERROR',
        message: 'no GSC sitemaps found; provide a URL or use --configured',
        displayMessage: 'Error: no GSC sitemaps found; provide a URL or use --configured',
        details: { command: 'google.submit-sitemap', project },
      })
    }
  }

  const batches = opts.all || opts.allFiles
    ? Array.from({ length: Math.ceil(sitemapUrls.length / 50) }, (_, index) => sitemapUrls.slice(index * 50, index * 50 + 50))
    : [sitemapUrls]
  const aggregate: GscSubmitSitemapsResponseDto = {
    summary: { total: 0, accepted: 0, failed: 0 },
    results: [],
  }
  for (const [index, batchSitemapUrls] of batches.entries()) {
    try {
      const result = await client.gscSubmitSitemaps(project, { sitemapUrls: batchSitemapUrls })
      aggregate.summary.total += result.summary.total
      aggregate.summary.accepted += result.summary.accepted
      aggregate.summary.failed += result.summary.failed
      aggregate.results.push(...result.results)
      opts.onProgress?.(index + 1, batches.length)
    } catch (cause) {
      if (index === 0) throw cause
      const attempted = aggregate.summary.total + batchSitemapUrls.length
      const remaining = sitemapUrls.length - attempted
      const causeDetails = cause instanceof CliError
        ? { code: cause.code, message: cause.message, details: cause.details }
        : { message: describeError(cause) }
      throw new CliError({
        code: 'GOOGLE_SITEMAP_SUBMISSION_PARTIAL',
        message: `Sitemap submission stopped at batch ${index + 1}/${batches.length}; ${aggregate.summary.accepted} accepted, ${aggregate.summary.failed} failed, ${batchSitemapUrls.length} unconfirmed, ${remaining} not attempted.`,
        displayMessage: `Sitemap submission stopped at batch ${index + 1}/${batches.length}; ${aggregate.summary.accepted} accepted, ${aggregate.summary.failed} failed, ${batchSitemapUrls.length} unconfirmed, ${remaining} not attempted. Earlier accepted submissions were not rolled back.`,
        exitCode: cause instanceof CliError && cause.exitCode === 1 ? 1 : EXIT_SYSTEM_ERROR,
        details: {
          project,
          accepted: aggregate.summary.accepted,
          failed: aggregate.summary.failed,
          completed: aggregate.summary.total,
          attempted,
          unconfirmed: batchSitemapUrls.length,
          remaining,
          unconfirmedBatch: { index: index + 1, total: batches.length, sitemapUrls: batchSitemapUrls },
          partialResult: aggregate,
          cause: causeDetails,
        },
      })
    }
  }
  return aggregate
}

export async function googleSubmitSitemaps(project: string, opts: GscSitemapSubmissionOptions & {
  format?: string
}): Promise<void> {
  const client = getClient()
  const result = await submitGscSitemaps(client, project, {
    ...opts,
    onProgress: !isMachineFormat(opts.format) && (opts.all || opts.allFiles)
      ? (completedBatches, totalBatches) => process.stderr.write(`Submitted sitemap batch ${completedBatches}/${totalBatches}\n`)
      : undefined,
  })
  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (opts.format === 'jsonl') {
    emitJsonl(result.results.map((entry) => ({ project, ...entry })))
    return
  }

  for (const entry of result.results) {
    if (entry.status === 'accepted') {
      console.log(`Accepted by Google for sitemap refetch: ${entry.sitemapUrl}`)
      if (entry.submittedAt) console.log(`  Submitted at: ${entry.submittedAt}`)
    } else {
      console.error(`Failed to submit sitemap: ${entry.sitemapUrl}`)
      if (entry.error) console.error(`  Error: ${entry.error}`)
    }
  }
  console.log(`Summary: ${result.summary.accepted} accepted, ${result.summary.failed} failed (${result.summary.total} total)`)
  console.log('Google accepting a sitemap for refetch does not guarantee indexing.')
}

export async function googleInspectSitemap(project: string, opts: {
  sitemapUrl?: string
  wait?: boolean
  format?: string
}): Promise<void> {
  const client = getClient()
  const run = await client.gscInspectSitemap(project, {
    sitemapUrl: opts.sitemapUrl,
  }) as { id: string; status: string; kind: string }

  if (!opts.wait && isMachineFormat(opts.format)) {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  if (!isMachineFormat(opts.format)) {
    console.log(`Sitemap inspection started (run ${run.id})`)
  }

  if (opts.wait) {
    const current = await waitForRunStatus(client, run.id, {
      timeoutMs: 30 * 60 * 1000,
      intervalMs: 3000,
      progressLabel: 'Waiting for sitemap inspection to complete',
      successStatuses: ['completed', 'partial'],
      failureStatuses: ['failed'],
      timeoutCode: 'GOOGLE_INSPECT_SITEMAP_TIMEOUT',
      failureCode: 'GOOGLE_INSPECT_SITEMAP_FAILED',
      timeoutMessage: 'Timed out waiting for sitemap inspection to complete.',
      failureMessage: 'Sitemap inspection failed.',
      details: { project },
    })

    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify({ ...run, status: current.status }, null, 2))
      return
    }

    if (current.status === 'partial') {
      console.log('Sitemap inspection completed with some errors.')
      return
    }

    console.log('Sitemap inspection completed successfully.')
  }
}

export async function googleCoverageHistory(project: string, opts: { limit?: number; format?: string }): Promise<void> {
  const client = getClient()
  const rows = await client.gscCoverageHistory(project, { limit: opts.limit }) as Array<{
    date: string
    indexed: number
    notIndexed: number
    reasonBreakdown: Record<string, number>
  }>

  if (opts.format === 'json') {
    console.log(JSON.stringify(rows, null, 2))
    return
  } else if (opts.format === 'jsonl') {
    emitJsonl(rows.map((row) => ({ project, ...row })))
    return
  }

  if (rows.length === 0) {
    console.log('No coverage history found. Run a GSC sync or sitemap inspection first.')
    return
  }

  console.log(`\nGSC Coverage History for "${project}" (${rows.length} snapshots):\n`)
  console.log(`  ${'DATE'.padEnd(12)}${'INDEXED'.padEnd(10)}${'NOT INDEXED'.padEnd(14)}TOP REASON`)
  console.log(`  ${'─'.repeat(12)}${'─'.repeat(10)}${'─'.repeat(14)}${'─'.repeat(30)}`)
  for (const row of rows) {
    const topReason = Object.entries(row.reasonBreakdown).sort((a, b) => b[1] - a[1])[0]
    const reasonStr = topReason ? `${topReason[0]} (${topReason[1]})` : '-'
    console.log(`  ${row.date.padEnd(12)}${String(row.indexed).padEnd(10)}${String(row.notIndexed).padEnd(14)}${reasonStr}`)
  }
}

export async function googleDiscoverSitemaps(project: string, opts: { wait?: boolean; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.gscDiscoverSitemaps(project) as {
    sitemaps: Array<{
      path: string
      lastSubmitted?: string
      isSitemapsIndex?: boolean
      contents?: Array<{ type: string; submitted: string }>
      warnings?: string
      errors?: string
    }>
    primarySitemapUrl: string
    run: { id: string; status: string }
  }

  if (!opts.wait && isMachineFormat(opts.format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (!isMachineFormat(opts.format)) {
    console.log(`\nDiscovered ${result.sitemaps.length} sitemap(s) for project "${project}":\n`)
    for (const s of result.sitemaps) {
      const primary = s.path === result.primarySitemapUrl ? ' (primary)' : ''
      const submitted = sitemapSubmittedUrlTotal(s.contents)
      console.log(`  ${s.path}${primary}`)
      console.log(`    Submitted URLs: ${submitted}  |  Last submitted: ${s.lastSubmitted ?? 'unknown'}`)
    }

    console.log(`\nPrimary sitemap: ${result.primarySitemapUrl}`)
    console.log(`Sitemap URL saved. Inspection run queued (run ${result.run.id}).`)
  }

  if (opts.wait) {
    const current = await waitForRunStatus(client, result.run.id, {
      timeoutMs: 30 * 60 * 1000,
      intervalMs: 3000,
      progressLabel: 'Waiting for sitemap inspection to complete',
      successStatuses: ['completed', 'partial'],
      failureStatuses: ['failed'],
      timeoutCode: 'GOOGLE_DISCOVER_SITEMAPS_TIMEOUT',
      failureCode: 'GOOGLE_DISCOVER_SITEMAPS_FAILED',
      timeoutMessage: 'Timed out waiting for sitemap inspection to complete.',
      failureMessage: 'Sitemap inspection failed.',
      details: { project },
    })

    if (isMachineFormat(opts.format)) {
      console.log(JSON.stringify({
        ...result,
        run: {
          ...result.run,
          status: current.status,
        },
      }, null, 2))
      return
    }

    if (current.status === 'partial') {
      console.log('Sitemap inspection completed with some errors.')
      return
    }

    console.log('Sitemap inspection completed successfully.')
  }
}

export async function googleRequestIndexing(project: string, opts: {
  url?: string
  allUnindexed?: boolean
  wait?: boolean
  format?: string
  /** @internal timing overrides for tests; not exposed to the CLI. */
  waitTimeoutMs?: number
  /** @internal timing overrides for tests; not exposed to the CLI. */
  waitPollIntervalMs?: number
}): Promise<void> {
  const client = getClient()

  const body: { urls: string[]; allUnindexed?: boolean } = { urls: [] }
  if (opts.allUnindexed) {
    body.allUnindexed = true
  } else if (opts.url) {
    body.urls = [opts.url]
  } else {
    throw new CliError({
      code: 'CLI_USAGE_ERROR',
      message: 'provide a URL or use --all-unindexed',
      displayMessage: 'Error: provide a URL or use --all-unindexed',
      details: { command: 'google.request-indexing' },
    })
  }

  if (!isMachineFormat(opts.format)) {
    console.error(INDEXING_API_SCOPE_NOTICE)
    console.error()
  }

  const result = await client.googleRequestIndexing(project, body) as {
    summary: { total: number; succeeded: number; failed: number }
    results: IndexingRequestResultDto[]
  }

  let indexingConfirmed = false
  const lastInspection = new Map<string, GscUrlInspectionDto>()
  if (opts.wait && result.results.some((r) => r.status === 'success')) {
    const successUrls = result.results.filter((r) => r.status === 'success').map((r) => r.url)
    const timeout = opts.waitTimeoutMs ?? 10 * 60 * 1000
    const pollInterval = opts.waitPollIntervalMs ?? 10_000
    const start = Date.now()
    process.stderr.write('Polling URL Inspection for indexed verdict')

    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, pollInterval))
      process.stderr.write('.')

      let allIndexed = true
      for (const url of successUrls) {
        try {
          const inspection = await client.gscInspect(project, url)
          lastInspection.set(url, inspection)
          if (inspection.verdict !== 'PASS') {
            allIndexed = false
          }
        } catch {
          allIndexed = false
        }
      }

      if (allIndexed) {
        process.stderr.write('\n')
        indexingConfirmed = true
        break
      }
    }

    if (!indexingConfirmed) {
      process.stderr.write('\n')
      const observed = successUrls.map((url) => {
        const i = lastInspection.get(url)
        return {
          url,
          verdict: i?.verdict ?? null,
          coverageState: i?.coverageState ?? null,
          indexingState: i?.indexingState ?? null,
        }
      })
      throw new CliError({
        code: 'GOOGLE_INDEXING_CONFIRMATION_TIMEOUT',
        message:
          "Timed out waiting for Google to report verdict=PASS. Google typically takes hours to days to index new URLs, so this is expected and does not mean the submission failed. Re-check later with `canonry google gsc inspect <url>`.",
        displayMessage:
          "Timed out waiting for Google to report verdict=PASS. Google typically takes hours to days to index new URLs — this is not a failure. Re-check later with `canonry google gsc inspect <url>`.",
        details: {
          project,
          urls: successUrls,
          lastObserved: observed,
        },
      })
    }
  }

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify({ ...result, ...(opts.wait ? { indexingConfirmed } : {}) }, null, 2))
    return
  }

  for (const r of result.results) {
    if (r.status === 'success') {
      console.log(`Indexing requested: ${r.url}`)
      console.log(`  Notified at: ${r.notifiedAt}`)
      console.log(`  Type: ${r.type}`)
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

  if (indexingConfirmed) {
    console.log('URL Inspection now reports verdict=PASS for the requested URLs (indexed in Google Search).')
  }
}

export async function googleRefresh(project: string, format?: string): Promise<void> {
  const client = getClient()

  // Trigger a GSC sync and wait for completion (same as UI refresh button)
  const run = await client.gscSync(project, {}) as { id: string; status: string; kind: string }

  if (!isMachineFormat(format)) {
    process.stderr.write('Refreshing GSC coverage data')
  }

  const current = await waitForRunStatus(client, run.id, {
    timeoutMs: 10 * 60 * 1000,
    intervalMs: 2000,
    progressLabel: '',
    successStatuses: ['completed', 'partial'],
    failureStatuses: ['failed'],
    timeoutCode: 'GOOGLE_REFRESH_TIMEOUT',
    failureCode: 'GOOGLE_REFRESH_FAILED',
    timeoutMessage: 'Timed out waiting for GSC refresh to complete.',
    failureMessage: 'GSC refresh failed.',
    details: { project },
  })

  if (current.status === 'partial' && !isMachineFormat(format)) {
    process.stderr.write('Refresh completed with some errors.\n')
  }

  // Display updated coverage (same as `canonry google coverage`)
  await googleCoverage(project, format)
}

export async function googleDeindexed(project: string, format?: string): Promise<void> {
  const client = getClient()
  const rows = await client.gscDeindexed(project) as Array<{
    url: string
    previousState: string
    currentState: string
    transitionDate: string
  }>

  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2))
    return
  } else if (format === 'jsonl') {
    emitJsonl(rows.map((row) => ({ project, ...row })))
    return
  }

  if (rows.length === 0) {
    console.log('No deindexed pages detected.')
    return
  }

  console.log(`Deindexed pages (${rows.length}):\n`)
  for (const row of rows) {
    console.log(`  ${row.url}`)
    console.log(`    ${row.previousState} -> ${row.currentState}  (detected: ${row.transitionDate})`)
    console.log()
  }
}
