import { formatPercent, queryClassFilterSchema, type QueryClassFilter, type RankedSourceList, type SourceBreakdownDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat, usageError } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

export const SOURCES_USAGE =
  'canonry sources <project> [--rank] [--limit N] [--by-provider] [--window 7d|30d|90d|all] [--query-class all|branded|non-brand] [--run-id <id>] [--include-by-query true|false] [--format json|jsonl]'

export interface SourcesOptions {
  rank?: boolean
  byProvider?: boolean
  limit?: number
  window?: string
  /** One answer-visibility run instead of every run in the window. */
  runId?: string
  /** Branded or non-brand answers only; omitted pools both (server default). */
  queryClass?: QueryClassFilter
  /** `false` drops the per-query breakdown; omitted keeps the server default (included). */
  includeByQuery?: boolean
  format?: string
}

/** `--query-class` → the API's class filter. Undefined when the flag is absent. */
export function parseSourcesQueryClass(value: string | undefined): QueryClassFilter | undefined {
  if (value === undefined) return undefined
  const parsed = queryClassFilterSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const message = `--query-class must be one of ${queryClassFilterSchema.options.join(', ')}`
  throw usageError(`Error: ${message}\nUsage: ${SOURCES_USAGE}`, {
    message,
    details: { command: 'sources', usage: SOURCES_USAGE, option: 'query-class', value },
  })
}

/** `--include-by-query true|false`. Undefined when the flag is absent, so the server default stands. */
export function parseSourcesIncludeByQuery(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  const message = '--include-by-query must be true or false'
  throw usageError(`Error: ${message}\nUsage: ${SOURCES_USAGE}`, {
    message,
    details: { command: 'sources', usage: SOURCES_USAGE, option: 'include-by-query', value },
  })
}

/**
 * `canonry sources <project>` — full ranked, per-provider, classified
 * cited-domain rankings. All counts/shares/classification come from the API
 * (`GET /analytics/sources`); this command only renders. See #675.
 */
export async function showSources(project: string, options: SourcesOptions): Promise<void> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw usageError(`Error: --limit must be a positive integer\nUsage: ${SOURCES_USAGE}`, {
      message: '--limit must be a positive integer',
      details: { command: 'sources', option: 'limit', value: options.limit },
    })
  }

  const client = getClient()
  const data = await client.getAnalyticsSources(project, {
    window: options.window,
    limit: options.limit,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.queryClass === undefined ? {} : { queryClass: options.queryClass }),
    ...(options.includeByQuery === undefined ? {} : { includeByQuery: options.includeByQuery }),
  })

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
  const scope = describeScope(data)
  if (scope) console.log(`  ${scope}`)

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
    for (const provider of data.providersWithoutSources ?? []) {
      console.log(`\n    ${provider}: answered, but no answer named a source`)
    }
  }
}

/**
 * What the counts pool. Each field is optional so an older server's response
 * still renders; nothing is printed when the server does not say.
 */
function describeScope(data: SourceBreakdownDto): string | null {
  const parts: string[] = []
  if (data.answerTotal !== undefined) parts.push(`${data.answerTotal} answers`)
  if (data.filters?.runId) parts.push(`run ${data.filters.runId}`)
  else if (data.runCount !== undefined) parts.push(`${data.runCount} ${data.runCount === 1 ? 'run' : 'runs'} pooled`)
  if (data.filters) {
    parts.push(data.filters.queryClass === 'all' ? 'branded and non-brand pooled' : `${data.filters.queryClass} queries only`)
  }
  if (data.unclassifiedAnswers) {
    parts.push(`${data.unclassifiedAnswers} unclassified ${data.unclassifiedAnswers === 1 ? 'answer' : 'answers'} excluded`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function printSurfaceClasses(list: RankedSourceList): void {
  for (const c of list.bySurfaceClass) {
    const noun = c.domainCount === 1 ? 'domain' : 'domains'
    console.log(`    ${c.label.padEnd(28)} ${formatPercent(c.percentage).padStart(6)}  (${c.count})  ${c.domainCount} ${noun}`)
  }
}

function printRankedEntries(list: RankedSourceList, indent = ''): void {
  for (const e of list.entries) {
    console.log(`${indent}    ${e.domain.padEnd(32)} ${String(e.count).padStart(4)}  ${formatPercent(e.percentage).padStart(6)}  ${e.surfaceClass}`)
  }
  if (list.truncatedDomainCount > 0) {
    console.log(`${indent}    … +${list.truncatedDomainCount} more domains (${list.truncatedCitedSlots} cited slots)`)
  }
}
