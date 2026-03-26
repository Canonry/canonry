import type { IndexingRequestResultDto } from '@ainyc/canonry-contracts'
import { ApiClient, createApiClient } from '../client.js'
import { CliError } from '../cli-error.js'

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

  if (opts.format === 'json') {
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
    const { exec } = await import('node:child_process')
    const platform = process.platform
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open'
    exec(`${cmd} "${authUrl}"`)
    console.log('(Browser opened automatically)')
  } catch {
    console.log('(Could not open browser automatically — please copy the URL above)')
  }
}

export async function googleDisconnect(project: string, opts: { type: string; format?: string }): Promise<void> {
  const client = getClient()
  await client.googleDisconnect(project, opts.type)

  if (opts.format === 'json') {
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

  if (format === 'json') {
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

  if (!opts.wait && opts.format === 'json') {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  if (opts.format !== 'json') {
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

    if (opts.format === 'json') {
      console.log(JSON.stringify({ ...run, status: current.status }, null, 2))
      return
    }

    console.log('GSC sync completed successfully.')
  }
}

export async function googlePerformance(project: string, opts: {
  days?: number
  keyword?: string
  page?: string
  format?: string
}): Promise<void> {
  const client = getClient()
  const params: Record<string, string> = {}
  if (opts.days) {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - opts.days)
    params.startDate = start.toISOString().split('T')[0]!
    params.endDate = end.toISOString().split('T')[0]!
  }
  if (opts.keyword) params.query = opts.keyword
  if (opts.page) params.page = opts.page

  const rows = await client.gscPerformance(project, Object.keys(params).length > 0 ? params : undefined) as Array<{
    date: string
    query: string
    page: string
    clicks: number
    impressions: number
    ctr: number
    position: number
  }>

  if (opts.format === 'json') {
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  if (rows.length === 0) {
    console.log('No GSC data found. Run "canonry google sync" first.')
    return
  }

  console.log(`GSC performance data (${rows.length} rows):\n`)
  console.log(`  ${'DATE'.padEnd(12)}${'QUERY'.padEnd(30)}${'CLICKS'.padEnd(8)}${'IMPR'.padEnd(8)}${'CTR'.padEnd(8)}${'POS'.padEnd(6)}`)
  console.log(`  ${'─'.repeat(12)}${'─'.repeat(30)}${'─'.repeat(8)}${'─'.repeat(8)}${'─'.repeat(8)}${'─'.repeat(6)}`)
  for (const row of rows.slice(0, 50)) {
    const query = row.query.length > 28 ? row.query.slice(0, 25) + '...' : row.query
    console.log(
      `  ${row.date.padEnd(12)}${query.padEnd(30)}${String(row.clicks).padEnd(8)}${String(row.impressions).padEnd(8)}${(row.ctr * 100).toFixed(1).padStart(5)}%  ${row.position.toFixed(1).padStart(5)}`,
    )
  }
  if (rows.length > 50) {
    console.log(`\n  ... and ${rows.length - 50} more rows (use --format json for full output)`)
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

  if (format === 'json') {
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

  if (format === 'json') {
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
  console.log(`  SUMMARY: ${pctColor}${summary.indexed} / ${summary.total} pages indexed (${summary.percentage}%)${reset}\n`)

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

  if (format === 'json') {
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
      contents?: Array<{ type: string; submitted: string; indexed: string }>
      warnings?: string
      errors?: string
    }>
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.sitemaps.length === 0) {
    console.log(`No sitemaps found for project "${project}". Submit a sitemap in Google Search Console first.`)
    return
  }

  console.log(`\nSitemaps for project "${project}":\n`)
  for (const s of result.sitemaps) {
    const indexed = s.contents?.[0]?.indexed ?? '?'
    const submitted = s.contents?.[0]?.submitted ?? '?'
    const isIndex = s.isSitemapsIndex ? ' [index]' : ''
    console.log(`  ${s.path}${isIndex}`)
    console.log(`    Indexed: ${indexed} / ${submitted} submitted  |  Last submitted: ${s.lastSubmitted ?? 'unknown'}`)
  }
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

  if (!opts.wait && opts.format === 'json') {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  if (opts.format !== 'json') {
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

    if (opts.format === 'json') {
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
      contents?: Array<{ type: string; submitted: string; indexed: string }>
      warnings?: string
      errors?: string
    }>
    primarySitemapUrl: string
    run: { id: string; status: string }
  }

  if (!opts.wait && opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (opts.format !== 'json') {
    console.log(`\nDiscovered ${result.sitemaps.length} sitemap(s) for project "${project}":\n`)
    for (const s of result.sitemaps) {
      const primary = s.path === result.primarySitemapUrl ? ' (primary)' : ''
      const indexed = s.contents?.[0]?.indexed ?? '?'
      const submitted = s.contents?.[0]?.submitted ?? '?'
      console.log(`  ${s.path}${primary}`)
      console.log(`    Indexed: ${indexed} / ${submitted} submitted  |  Last submitted: ${s.lastSubmitted ?? 'unknown'}`)
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

    if (opts.format === 'json') {
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

  const result = await client.googleRequestIndexing(project, body) as {
    summary: { total: number; succeeded: number; failed: number }
    results: IndexingRequestResultDto[]
  }

  let indexingConfirmed = false
  if (opts.wait && result.results.some((r) => r.status === 'success')) {
    const successUrls = result.results.filter((r) => r.status === 'success').map((r) => r.url)
    const timeout = 10 * 60 * 1000
    const start = Date.now()
    process.stderr.write('Waiting for indexing confirmation')

    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 10000))
      process.stderr.write('.')

      let allIndexed = true
      for (const url of successUrls) {
        try {
          const inspection = await client.gscInspect(project, url) as {
            indexingState?: string
          }
          if (inspection.indexingState !== 'INDEXING_ALLOWED') {
            allIndexed = false
            break
          }
        } catch {
          allIndexed = false
          break
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
      throw new CliError({
        code: 'GOOGLE_INDEXING_CONFIRMATION_TIMEOUT',
        message: 'Timed out waiting for indexing confirmation. URLs may still be processing.',
        displayMessage: 'Timed out waiting for indexing confirmation. URLs may still be processing.',
        details: {
          project,
          urls: successUrls,
        },
      })
    }
  }

  if (opts.format === 'json') {
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
    console.log('All requested URLs are now indexed.')
  }
}

export async function googleRefresh(project: string, format?: string): Promise<void> {
  const client = getClient()

  // Trigger a GSC sync and wait for completion (same as UI refresh button)
  const run = await client.gscSync(project, {}) as { id: string; status: string; kind: string }

  if (format !== 'json') {
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

  if (current.status === 'partial' && format !== 'json') {
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
