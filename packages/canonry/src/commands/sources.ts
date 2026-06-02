import type { RankedSourceList, SourceBreakdownDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat, usageError } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

export interface SourcesOptions {
  rank?: boolean
  byProvider?: boolean
  limit?: number
  window?: string
  format?: string
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

/**
 * `canonry sources <project>` — full ranked, per-provider, classified
 * cited-domain rankings. All counts/shares/classification come from the API
 * (`GET /analytics/sources`); this command only renders. See #675.
 */
export async function showSources(project: string, options: SourcesOptions): Promise<void> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw usageError('Error: --limit must be a positive integer\nUsage: canonry sources <project> [--rank] [--limit N] [--by-provider] [--window 7d|30d|90d|all] [--format json|jsonl]', {
      message: '--limit must be a positive integer',
      details: { command: 'sources', option: 'limit', value: options.limit },
    })
  }

  const client = getClient()
  const data = await client.getAnalyticsSources(project, { window: options.window, limit: options.limit })

  // jsonl streams the primary collection — the flat ranked domain list — one
  // self-contained record per line, stamped with the project.
  if (options.format === 'jsonl') {
    emitJsonl(data.ranked.entries.map(e => ({ project, ...e })))
    return
  }

  // json emits the whole DTO directly (clean parity with the API response).
  if (isMachineFormat(options.format)) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  printSourceRankings(data, options)
}

function printSourceRankings(data: SourceBreakdownDto, options: SourcesOptions): void {
  console.log(`\nSource Rankings (${data.window})`)
  console.log('─'.repeat(50))

  if (data.ranked.totalCitedSlots === 0) {
    console.log('  No source data available')
    return
  }

  console.log('\n  By surface class:')
  printSurfaceClasses(data.ranked)

  if (options.rank) {
    console.log('\n  Top sources:')
    printRankedEntries(data.ranked)
  }

  if (options.byProvider) {
    console.log('\n  By provider:')
    for (const [provider, list] of Object.entries(data.byProvider)) {
      console.log(`\n    ${provider} (${list.totalCitedSlots} cited slots):`)
      printRankedEntries(list, '    ')
    }
  }
}

function printSurfaceClasses(list: RankedSourceList): void {
  for (const c of list.bySurfaceClass) {
    const noun = c.domainCount === 1 ? 'domain' : 'domains'
    console.log(`    ${c.label.padEnd(28)} ${pct(c.percentage).padStart(6)}  (${c.count})  ${c.domainCount} ${noun}`)
  }
}

function printRankedEntries(list: RankedSourceList, indent = ''): void {
  for (const e of list.entries) {
    console.log(`${indent}    ${e.domain.padEnd(32)} ${String(e.count).padStart(4)}  ${pct(e.percentage).padStart(6)}  ${e.surfaceClass}`)
  }
  if (list.truncatedDomainCount > 0) {
    console.log(`${indent}    … +${list.truncatedDomainCount} more domains (${list.truncatedCitedSlots} cited slots)`)
  }
}
