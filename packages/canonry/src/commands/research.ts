import { createApiClient } from '../client.js'
import type { ApiClient } from '../client.js'
import {
  CitationStates,
  ResearchRunStatuses,
  type LocationContext,
  type ResearchPromotionPreviewRequest,
  type ResearchPromotionPreviewResponse,
  type ResearchRunCreate,
  type ResearchRunDetailDto,
  type ResearchRunStatus,
  type ResearchRunSummaryDto,
} from '@ainyc/canonry-contracts'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

const TERMINAL_RESEARCH_STATUSES = new Set<ResearchRunStatus>([
  ResearchRunStatuses.completed,
  ResearchRunStatuses.partial,
  ResearchRunStatuses.failed,
])
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 15 * 60 * 1000

function getClient(): ApiClient {
  return createApiClient()
}

export interface ResearchRunOptions {
  queries: string[]
  provider?: string
  model?: string
  location?: LocationContext | null
  idempotencyKey?: string
  wait?: boolean
  format?: string
}

/** A batch is intentionally not a tracked-query mutation. */
export async function researchRun(project: string, opts: ResearchRunOptions): Promise<void> {
  const client = getClient()
  const request: ResearchRunCreate = {
    queries: opts.queries,
    provider: opts.provider,
    model: opts.model,
    location: opts.location,
    idempotencyKey: opts.idempotencyKey,
  }
  const started = await client.startResearchRun(project, request)

  if (!opts.wait) {
    if (opts.format === 'jsonl') {
      emitJsonl([{ project, ...started }])
      return
    }
    if (opts.format === 'json') {
      console.log(JSON.stringify(started, null, 2))
      return
    }
    printStarted(project, started)
    return
  }

  const detail = await pollResearchRun(client, project, started.id, isMachineFormat(opts.format))
  printDetail(project, detail, opts.format)
}

export async function researchList(project: string, opts: { limit?: number; format?: string }): Promise<void> {
  const client = getClient()
  const { runs } = await client.listResearchRuns(project, opts.limit === undefined ? undefined : { limit: opts.limit })
  if (opts.format === 'json') {
    console.log(JSON.stringify({ runs }, null, 2))
    return
  }
  if (opts.format === 'jsonl') {
    emitJsonl(runs.map(run => ({ project, ...run })))
    return
  }
  if (runs.length === 0) {
    console.log(`No saved research runs for "${project}".`)
    return
  }
  console.log(`Research history for "${project}" (${runs.length}):\n`)
  console.log('  ID                                    STATUS      QUERIES  PROVIDER / MODEL                  CREATED')
  console.log('  ────────────────────────────────────  ──────────  ───────  ────────────────────────────────  ───────────────────────')
  for (const run of runs) {
    const model = run.resolvedModel ? `${run.provider} / ${run.resolvedModel}` : run.provider
    console.log(`  ${run.id.padEnd(36)}  ${run.status.padEnd(10)}  ${String(run.totalQueries).padStart(7)}  ${model.slice(0, 32).padEnd(32)}  ${run.createdAt}`)
  }
}

export async function researchShow(project: string, runId: string, opts: { format?: string }): Promise<void> {
  const detail = await getClient().getResearchRun(project, runId)
  printDetail(project, detail, opts.format)
}

/**
 * Preview only: the route deliberately writes no tracked query or measurement
 * draft. A later explicit commit route will own durable promotion.
 */
export async function researchPromotionPreview(
  project: string,
  runId: string,
  queryId: string,
  opts: ResearchPromotionPreviewRequest & { format?: string },
): Promise<void> {
  const { format, ...request } = opts
  const preview = await getClient().previewResearchPromotion(project, runId, queryId, request)
  if (format === 'json') {
    console.log(JSON.stringify(preview, null, 2))
    return
  }
  if (format === 'jsonl') {
    emitJsonl([{ project, runId, queryId, ...preview }])
    return
  }
  printPromotionPreview(preview)
}

async function pollResearchRun(client: ApiClient, project: string, runId: string, quiet: boolean): Promise<ResearchRunDetailDto> {
  if (!quiet) process.stderr.write(`Waiting for research run ${runId}`)
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    if (Date.now() > deadline) {
      throw new CliError({
        code: 'RESEARCH_TIMEOUT',
        message: `Timed out waiting for research run ${runId} after ${POLL_TIMEOUT_MS / 1000}s`,
      })
    }
    const detail = await client.getResearchRun(project, runId)
    if (!quiet) process.stderr.write('.')
    if (TERMINAL_RESEARCH_STATUSES.has(detail.status)) {
      if (!quiet) process.stderr.write('\n')
      return detail
    }
  }
}

function printStarted(project: string, run: ResearchRunSummaryDto): void {
  console.log(`Research run saved: ${run.id}`)
  console.log(`  Status:   ${run.status}`)
  console.log(`  Queries:  ${run.totalQueries}`)
  console.log(`  Provider: ${run.provider}${run.resolvedModel ? ` / ${run.resolvedModel}` : ''}`)
  console.log(`  Inspect:  canonry research show ${project} ${run.id}`)
  console.log('  Nothing was added to tracked queries.')
}

function printPromotionPreview(preview: ResearchPromotionPreviewResponse): void {
  if (preview.mode === 'refused') {
    console.log(`Promotion preview refused: ${preview.refusal.message}`)
    return
  }
  console.log(`Promotion preview: ${preview.mode}`)
  console.log(`  Tracked query: ${preview.trackedQuery.query}`)
  if (preview.trackedQuery.state === 'existing') {
    console.log(`  Reuses: ${preview.trackedQuery.id}`)
  } else {
    console.log(`  Proposed ID: ${preview.trackedQuery.proposedId}`)
  }
  if (preview.mode === 'simple') {
    console.log('  No measurement-plan changes are proposed.')
  } else {
    console.log(`  Assignments added: ${preview.assignments.added}`)
    console.log(`  Provider calls added: ${preview.execution.addedProviderCalls}`)
  }
  console.log(`  Preview checksum: ${preview.previewChecksum}`)
  console.log('  No changes were made.')
}

function printDetail(project: string, detail: ResearchRunDetailDto, format?: string): void {
  if (format === 'json') {
    console.log(JSON.stringify(detail, null, 2))
    return
  }
  if (format === 'jsonl') {
    emitJsonl(detail.queries.map(query => ({ project, runId: detail.id, ...query })))
    return
  }
  console.log(`Research run: ${detail.id}`)
  console.log(`  Status:   ${detail.status}`)
  console.log(`  Provider: ${detail.provider}${detail.resolvedModel ? ` / ${detail.resolvedModel}` : ''}`)
  if (detail.location) console.log(`  Location: ${detail.location.label}`)
  console.log(`  Results:  ${detail.completedQueries} completed, ${detail.failedQueries} failed, ${detail.totalQueries} total`)
  if (detail.error) console.log(`  Error:    ${detail.error}`)
  console.log('  Nothing was added to tracked queries.')
  if (detail.queries.length === 0) return
  console.log('\n  QUERY                                                       STATUS      CITED  MENTIONED')
  for (const query of detail.queries) {
    const cited = query.citationState === CitationStates.cited ? 'yes' : query.citationState ? 'no' : '–'
    const mentioned = query.answerMentioned === null ? '–' : query.answerMentioned ? 'yes' : 'no'
    console.log(`  ${query.query.slice(0, 58).padEnd(58)}  ${query.status.padEnd(10)}  ${cited.padEnd(5)}  ${mentioned}`)
    if (query.error) console.log(`    Error: ${query.error}`)
    if (query.answerText) console.log(`    Answer: ${query.answerText}`)
    if (query.namedCompetitors.length > 0) {
      console.log(`    Named competitors: ${query.namedCompetitors.join(', ')}`)
    }
    if (query.citedCompetitorDomains.length > 0) {
      console.log(`    Cited competitor domains: ${query.citedCompetitorDomains.join(', ')}`)
    }
    if (query.groundingSources.length > 0) {
      console.log('    Sources:')
      for (const source of query.groundingSources) {
        console.log(`      - ${source.title ? `${source.title}: ` : ''}${source.uri}`)
      }
    }
  }
}
