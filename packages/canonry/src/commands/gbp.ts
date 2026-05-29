import type { GbpLocationListResponse } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}

function formatLocationsTable(response: GbpLocationListResponse): string {
  if (response.locations.length === 0) {
    return 'No GBP locations discovered yet. Run `canonry gbp locations discover <project>` first.'
  }
  const lines: string[] = []
  lines.push(`Discovered ${response.totalDiscovered} location(s), ${response.totalSelected} selected for sync:\n`)
  for (const loc of response.locations) {
    const flag = loc.selected ? '✓' : ' '
    const category = loc.primaryCategoryDisplayName ?? 'unknown'
    lines.push(`  [${flag}]  ${loc.locationName.padEnd(18)}  ${loc.displayName}  (${category})`)
  }
  return lines.join('\n')
}

export async function gbpConnect(
  project: string,
  opts: { publicUrl?: string; format?: string },
): Promise<void> {
  const client = getClient()
  const { authUrl, redirectUri } = await client.googleConnect(project, {
    type: 'gbp',
    publicUrl: opts.publicUrl,
  })

  if (opts.format === 'json') {
    console.log(JSON.stringify({ project, type: 'gbp', authUrl, redirectUri: redirectUri ?? null }, null, 2))
    return
  }

  console.log('\nOpen this URL in your browser to authorize Google Business Profile access:\n')
  console.log(`  ${authUrl}\n`)
  if (redirectUri) {
    console.log(`Redirect URI: ${redirectUri}`)
    console.log("(Ensure this URI is listed in your Google Cloud Console OAuth client's authorized redirect URIs)\n")
  }
  console.log('After authorizing, run `canonry gbp locations discover <project>` to fetch your locations.')
}

export async function gbpDisconnect(project: string, opts: { format?: string }): Promise<void> {
  const client = getClient()
  await client.disconnectGbp(project)
  if (opts.format === 'json') {
    console.log(JSON.stringify({ project, disconnected: true }, null, 2))
    return
  }
  console.log(`Disconnected GBP from project "${project}" and removed all discovered locations.`)
}

export async function gbpLocationsList(
  project: string,
  opts: { format?: string; selectedOnly?: boolean },
): Promise<void> {
  const client = getClient()
  const response = await client.listGbpLocations(
    project,
    opts.selectedOnly ? { selected: true } : undefined,
  )

  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  console.log(formatLocationsTable(response))
}

export async function gbpLocationsDiscover(
  project: string,
  opts: { format?: string; selectAllNew?: boolean },
): Promise<void> {
  const client = getClient()
  const body = opts.selectAllNew === undefined ? undefined : { selectAllNew: opts.selectAllNew }
  const response = await client.discoverGbpLocations(project, body)

  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  console.log(`\nDiscovered ${response.totalDiscovered} location(s); ${response.totalSelected} selected for sync.`)
  console.log(formatLocationsTable(response))
}

export async function gbpLocationSelect(
  project: string,
  opts: { location: string; format?: string },
): Promise<void> {
  const client = getClient()
  const updated = await client.setGbpLocationSelection(project, opts.location, true)
  if (opts.format === 'json') {
    console.log(JSON.stringify(updated, null, 2))
    return
  }
  console.log(`Selected ${opts.location} ("${updated.displayName}") for sync.`)
}

export async function gbpLocationDeselect(
  project: string,
  opts: { location: string; format?: string },
): Promise<void> {
  const client = getClient()
  const updated = await client.setGbpLocationSelection(project, opts.location, false)
  if (opts.format === 'json') {
    console.log(JSON.stringify(updated, null, 2))
    return
  }
  console.log(`Deselected ${opts.location} ("${updated.displayName}"). Future syncs will skip this location.`)
}

export async function gbpSync(
  project: string,
  opts: { location?: string; days?: number; months?: number; wait?: boolean; format?: string },
): Promise<void> {
  const client = getClient()
  const { runId, status } = await client.triggerGbpSync(project, {
    locationNames: opts.location ? [opts.location] : undefined,
    daysOfMetrics: opts.days,
    monthsOfKeywords: opts.months,
  })

  if (!opts.wait) {
    if (opts.format === 'json') {
      console.log(JSON.stringify({ runId, status }, null, 2))
      return
    }
    console.log(`GBP sync started (run ${runId}). Use \`canonry runs get ${runId}\` to check status, or pass --wait.`)
    return
  }

  // Poll the run to a terminal state.
  const terminal = new Set(['completed', 'partial', 'failed', 'cancelled'])
  const start = Date.now()
  const timeoutMs = 10 * 60 * 1000
  if (opts.format !== 'json') process.stderr.write('Syncing')
  let final = status
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const run = await client.getRun(runId)
    if (opts.format !== 'json') process.stderr.write('.')
    if (terminal.has(run.status)) { final = run.status; break }
  }
  if (opts.format !== 'json') process.stderr.write('\n')

  if (opts.format === 'json') {
    console.log(JSON.stringify({ runId, status: final }, null, 2))
    return
  }
  console.log(`GBP sync ${final} (run ${runId}).`)
}

export async function gbpMetrics(
  project: string,
  opts: { location?: string; metric?: string; format?: string },
): Promise<void> {
  const client = getClient()
  const response = await client.listGbpMetrics(project, { locationName: opts.location, metric: opts.metric })
  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  if (response.metrics.length === 0) {
    console.log('No GBP metrics stored. Run `canonry gbp sync <project>` first.')
    return
  }
  // Aggregate totals per metric for a quick scan.
  const totals = new Map<string, number>()
  for (const m of response.metrics) totals.set(m.metric, (totals.get(m.metric) ?? 0) + m.value)
  console.log(`${response.total} metric row(s). Totals by metric:`)
  for (const [metric, total] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${metric.padEnd(40)} ${total}`)
  }
}

export async function gbpKeywords(
  project: string,
  opts: { location?: string; month?: string; format?: string },
): Promise<void> {
  const client = getClient()
  const response = await client.listGbpKeywords(project, { locationName: opts.location, month: opts.month })
  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  if (response.keywords.length === 0) {
    console.log('No GBP keyword impressions stored. Run `canonry gbp sync <project>` first.')
    return
  }
  console.log(`${response.total} keyword(s), ${response.thresholdedPct}% privacy-thresholded. Top by impressions:`)
  for (const k of response.keywords.slice(0, 15)) {
    const val = k.valueCount !== null ? String(k.valueCount) : `<${k.valueThreshold ?? '?'}`
    console.log(`  ${val.padStart(8)}  ${k.keyword}`)
  }
}
