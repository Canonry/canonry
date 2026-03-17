import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

const TERMINAL_STATUSES = new Set(['completed', 'failed'])

interface SweepRow {
  id: string
  projectId: string
  status: string
  trigger: string
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

interface SweepResultRow {
  id: string
  sweepId: string
  keywordId: string
  keyword?: string | null
  domain: string
  domainRole: string
  indexedPageCount: number
  topPages: Array<{ url: string; title: string }>
  createdAt: string
}

/**
 * `canonry sweep <project>`
 * Trigger an indexing sweep for all keywords in the project.
 */
export async function triggerSweep(
  project: string,
  opts?: { keyword?: string; wait?: boolean; format?: string },
): Promise<void> {
  const client = getClient()
  const body: Record<string, unknown> = {}
  if (opts?.keyword) {
    body.keyword = opts.keyword
  }

  const sweep = (await client.triggerSweep(project, body)) as SweepRow

  if (opts?.format === 'json') {
    if (opts?.wait) {
      const result = await pollSweep(client, sweep.id)
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(JSON.stringify(sweep, null, 2))
    }
    return
  }

  console.log(`Sweep created: ${sweep.id}`)
  console.log(`  Status:  ${sweep.status}`)
  console.log(`  Trigger: ${sweep.trigger}`)

  if (opts?.wait) {
    process.stderr.write(`Waiting for sweep ${sweep.id}`)
    const result = await pollSweep(client, sweep.id)
    process.stderr.write('\n')
    printSweepDetail(result as SweepRow)
  }
}

/**
 * `canonry sweeps <project>`
 * List past indexing sweeps for a project.
 */
export async function listSweeps(project: string, format?: string): Promise<void> {
  const client = getClient()
  const sweeps = (await client.listSweeps(project)) as SweepRow[]

  if (format === 'json') {
    console.log(JSON.stringify(sweeps, null, 2))
    return
  }

  if (sweeps.length === 0) {
    console.log(`No indexing sweeps found for "${project}".`)
    return
  }

  console.log(`Indexing sweeps for "${project}" (${sweeps.length}):\n`)
  console.log('  ID                                    STATUS      TRIGGER    CREATED')
  console.log('  ────────────────────────────────────  ──────────  ─────────  ──────────────────────')

  for (const s of sweeps) {
    console.log(
      `  ${s.id}  ${s.status.padEnd(10)}  ${s.trigger.padEnd(9)}  ${s.createdAt}`,
    )
  }
}

/**
 * `canonry sweep show <id>`
 * Show details (including results) of a specific sweep.
 */
export async function showSweep(id: string, format?: string): Promise<void> {
  const client = getClient()
  const sweep = (await client.getSweep(id)) as SweepRow & { results?: SweepResultRow[] }

  if (format === 'json') {
    console.log(JSON.stringify(sweep, null, 2))
    return
  }

  printSweepDetail(sweep)

  const results = sweep.results ?? []
  if (results.length === 0) {
    console.log('\n  No results recorded yet.')
    return
  }

  // Group by keyword
  const byKeyword = new Map<string, SweepResultRow[]>()
  for (const r of results) {
    const kw = r.keyword ?? r.keywordId
    if (!byKeyword.has(kw)) byKeyword.set(kw, [])
    byKeyword.get(kw)!.push(r)
  }

  console.log('\n  Content Coverage:\n')
  for (const [kw, rows] of byKeyword) {
    console.log(`  Keyword: "${kw}"`)
    for (const r of rows) {
      const role = r.domainRole === 'client' ? '  (client)   ' : '  (competitor)'
      console.log(`    ${role}  ${r.domain.padEnd(40)}  ${r.indexedPageCount} indexed pages`)
      for (const page of (r.topPages ?? []).slice(0, 3)) {
        console.log(`      - ${page.title} — ${page.url}`)
      }
    }
    console.log()
  }
}

async function pollSweep(client: ApiClient, sweepId: string): Promise<object> {
  const deadline = Date.now() + 10 * 60 * 1000 // 10 minutes
  for (;;) {
    await new Promise(r => setTimeout(r, 2000))
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for sweep ${sweepId}`)
    }
    const sweep = (await client.getSweep(sweepId)) as { status: string }
    process.stderr.write('.')
    if (TERMINAL_STATUSES.has(sweep.status)) {
      return sweep
    }
  }
}

function printSweepDetail(sweep: SweepRow): void {
  console.log(`Sweep: ${sweep.id}`)
  console.log(`  Status:   ${sweep.status}`)
  console.log(`  Trigger:  ${sweep.trigger}`)
  if (sweep.startedAt) console.log(`  Started:  ${sweep.startedAt}`)
  if (sweep.finishedAt) console.log(`  Finished: ${sweep.finishedAt}`)
  console.log(`  Created:  ${sweep.createdAt}`)
}
