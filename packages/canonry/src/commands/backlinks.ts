import type {
  BacklinkListResponse,
  BacklinkSummaryDto,
  BacklinksInstallResultDto,
  BacklinksInstallStatusDto,
  CcAvailableRelease,
  CcCachedRelease,
  CcReleaseSyncDto,
  RunDto,
} from '@ainyc/canonry-contracts'
import { CcReleaseSyncStatuses, RunStatuses, formatRunErrorOneLine } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}

export interface FormatOptions {
  format?: string
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

export function formatInstallStatus(status: BacklinksInstallStatusDto): string {
  const lines: string[] = []
  lines.push(status.duckdbInstalled ? 'DuckDB: installed' : 'DuckDB: not installed')
  if (status.duckdbVersion) lines.push(`Version: ${status.duckdbVersion}`)
  lines.push(`Spec:    ${status.duckdbSpec}`)
  lines.push(`Plugin:  ${status.pluginDir}`)
  if (!status.duckdbInstalled) {
    lines.push('')
    lines.push('Run `canonry backlinks install` to enable backlinks.')
  }
  return lines.join('\n')
}

export function formatSync(sync: CcReleaseSyncDto): string {
  const lines: string[] = []
  lines.push(`Release: ${sync.release}`)
  lines.push(`Status:  ${sync.status}`)
  if (sync.phaseDetail) lines.push(`Phase:   ${sync.phaseDetail}`)
  if (typeof sync.projectsProcessed === 'number') lines.push(`Projects: ${sync.projectsProcessed}`)
  if (typeof sync.domainsDiscovered === 'number') lines.push(`Domains:  ${sync.domainsDiscovered}`)
  if (sync.error) lines.push(`Error:   ${sync.error}`)
  return lines.join('\n')
}

export function formatSummaryAndDomains(
  project: string,
  response: BacklinkListResponse,
): string {
  const lines: string[] = []
  lines.push(`Project: ${project}`)
  if (!response.summary) {
    lines.push('No ready release — run `canonry backlinks sync --release <id>` first.')
    return lines.join('\n')
  }
  const s = response.summary
  lines.push(`Release: ${s.release}`)
  lines.push(`Target:  ${s.targetDomain}`)
  lines.push(`Linking domains: ${s.totalLinkingDomains}`)
  lines.push(`Total hosts:     ${s.totalHosts}`)
  lines.push(`Top-10 share:    ${s.top10HostsShare}`)
  if (response.rows.length > 0) {
    lines.push('')
    lines.push(`Top ${response.rows.length} linking domains (of ${response.total}):`)
    for (const r of response.rows) {
      lines.push(`  ${String(r.numHosts).padStart(9)}  ${r.linkingDomain}`)
    }
  }
  return lines.join('\n')
}

export function formatCachedReleases(rows: CcCachedRelease[]): string {
  if (rows.length === 0) return 'No cached releases.'
  const lines: string[] = []
  lines.push('Release                        Status       Bytes        Last used')
  for (const r of rows) {
    const status = (r.syncStatus ?? 'unknown').padEnd(12)
    const bytes = String(r.bytes).padStart(12)
    const lastUsed = r.lastUsedAt ?? '-'
    lines.push(`${r.release.padEnd(30)} ${status} ${bytes}  ${lastUsed}`)
  }
  return lines.join('\n')
}

function formatInstallResult(result: BacklinksInstallResultDto): string {
  if (result.alreadyPresent) {
    return `DuckDB already installed (${result.version}) at ${result.path}`
  }
  return `DuckDB installed (${result.version}) at ${result.path}`
}

async function pollSync(id: string, format?: string): Promise<CcReleaseSyncDto> {
  const client = getClient()
  const terminal = new Set<CcReleaseSyncDto['status']>([
    CcReleaseSyncStatuses.ready,
    CcReleaseSyncStatuses.failed,
  ])
  while (true) {
    const syncs = await client.backlinksListSyncs()
    const row = syncs.find((s) => s.id === id)
    if (!row) throw new Error(`Release sync ${id} not found`)
    if (terminal.has(row.status)) return row
    if (format !== 'json') {
      process.stderr.write(`\r${row.status}${row.phaseDetail ? ': ' + row.phaseDetail : ''}`.padEnd(80))
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

async function pollRun(runId: string, format?: string): Promise<RunDto> {
  const client = getClient()
  const terminal = new Set<RunDto['status']>([
    RunStatuses.completed,
    RunStatuses.failed,
    RunStatuses.partial,
  ])
  while (true) {
    const run = await client.getRun(runId)
    if (terminal.has(run.status)) return run
    if (format !== 'json') {
      process.stderr.write(`\r${run.status}`.padEnd(40))
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

export async function backlinksInstall(opts: FormatOptions = {}): Promise<void> {
  const result = await getClient().backlinksInstall()
  if (opts.format === 'json') {
    printJson(result)
    return
  }
  console.log(formatInstallResult(result))
}

export async function backlinksDoctor(opts: FormatOptions = {}): Promise<void> {
  const status = await getClient().backlinksStatus()
  if (opts.format === 'json') {
    printJson(status)
    return
  }
  console.log(formatInstallStatus(status))
}

export async function backlinksSync(opts: FormatOptions & { release?: string; wait?: boolean }): Promise<void> {
  const client = getClient()
  const sync = await client.backlinksTriggerSync(opts.release)
  const final = opts.wait ? await pollSync(sync.id, opts.format) : sync
  if (opts.format === 'json') {
    printJson(final)
    return
  }
  if (opts.wait) process.stderr.write('\n')
  if (!opts.release) {
    process.stderr.write(`Auto-discovered release: ${sync.release}\n`)
  }
  console.log(formatSync(final))
}

function formatBytesShort(n: number | null): string {
  if (n === null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`
  return `${n} B`
}

export function formatLatestRelease(result: CcAvailableRelease | null): string {
  if (!result) return 'No release discovered (Common Crawl probe returned no candidates).'
  const lines: string[] = []
  lines.push(`Release: ${result.release}`)
  lines.push(`Vertex:  ${result.vertexUrl}`)
  lines.push(`         ${formatBytesShort(result.vertexBytes)}`)
  lines.push(`Edges:   ${result.edgesUrl}`)
  lines.push(`         ${formatBytesShort(result.edgesBytes)}`)
  if (result.lastModified) lines.push(`Last modified: ${result.lastModified}`)
  return lines.join('\n')
}

export async function backlinksLatestRelease(opts: FormatOptions = {}): Promise<void> {
  const result = await getClient().backlinksLatestRelease()
  if (opts.format === 'json') {
    printJson(result)
    return
  }
  console.log(formatLatestRelease(result))
}

export async function backlinksStatus(opts: FormatOptions = {}): Promise<void> {
  const sync = await getClient().backlinksLatestSync()
  if (opts.format === 'json') {
    printJson(sync)
    return
  }
  if (!sync) {
    console.log('No release syncs yet.')
    return
  }
  console.log(formatSync(sync))
}

export async function backlinksList(opts: FormatOptions & {
  project: string
  limit?: number
  release?: string
}): Promise<void> {
  const client = getClient()
  const response = await client.backlinksDomains(opts.project, {
    limit: opts.limit ?? 50,
    release: opts.release,
  })
  if (opts.format === 'json') {
    printJson(response)
    return
  }
  console.log(formatSummaryAndDomains(opts.project, response))
}

export async function backlinksReleases(opts: FormatOptions = {}): Promise<void> {
  const rows = await getClient().backlinksCachedReleases()
  if (opts.format === 'json') {
    printJson(rows)
    return
  }
  console.log(formatCachedReleases(rows))
}

export async function backlinksExtract(opts: FormatOptions & {
  project: string
  release?: string
  wait?: boolean
}): Promise<void> {
  const client = getClient()
  const run = await client.backlinksExtract(opts.project, opts.release)
  const final = opts.wait ? await pollRun(run.id, opts.format) : run
  if (opts.format === 'json') {
    printJson(final)
    return
  }
  if (opts.wait) process.stderr.write('\n')
  console.log(`Run ${final.id} (${final.status})${final.error ? ' — ' + formatRunErrorOneLine(final.error) : ''}`)
}

export async function backlinksCachePrune(opts: FormatOptions & {
  release?: string
}): Promise<void> {
  if (!opts.release) {
    throw new Error('Usage: canonry backlinks cache prune --release <id>')
  }
  const result = await getClient().backlinksPruneCache(opts.release)
  if (opts.format === 'json') {
    printJson({ pruned: opts.release, ...result })
    return
  }
  console.log(`Pruned cache for ${opts.release}`)
}

export { type BacklinkListResponse, type BacklinkSummaryDto }
