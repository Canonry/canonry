import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'
import { CliError } from '../cli-error.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

export async function bingConnect(project: string, opts?: { apiKey?: string; format?: string }): Promise<void> {
  let apiKey = opts?.apiKey

  if (!apiKey) {
    const readline = await import('node:readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })

    apiKey = await new Promise<string>((resolve) => {
      rl.question('Bing Webmaster Tools API key: ', (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    })
  }

  if (!apiKey) {
    throw new CliError({
      code: 'BING_API_KEY_REQUIRED',
      message: 'API key is required (pass --api-key or enter interactively)',
      displayMessage: 'Error: API key is required (pass --api-key or enter interactively)',
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

  if (opts?.format === 'json') {
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

  if (format === 'json') {
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

  if (format === 'json') {
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

  if (format === 'json') {
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

  if (format === 'json') {
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
  console.log(`  SUMMARY: ${pctColor}${summary.indexed} / ${summary.total} pages indexed (${summary.percentage}%)${reset}${unknownNote}\n`)

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

  if (format === 'json') {
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

  if (opts.format === 'json') {
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
      `  ${query.padEnd(40)}${String(row.clicks).padEnd(8)}${String(row.impressions).padEnd(8)}${(row.ctr * 100).toFixed(1).padStart(5)}%  ${row.averagePosition.toFixed(1).padStart(5)}`,
    )
  }
  if (rows.length > 50) {
    console.log(`\n  ... and ${rows.length - 50} more rows (use --format json for full output)`)
  }
}
