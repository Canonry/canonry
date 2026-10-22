import { readFileSync } from 'node:fs'
import { createApiClient } from '../client.js'
import type { ApiClient } from '../client.js'
import {
  answerCompletionLabel,
  answerCostBasisLabel,
  CitationStates,
  ResearchRunStatuses,
  TERMINAL_RESEARCH_RUN_STATUSES,
  researchBatchCreateSchema,
  type AnswerEvidence,
  type LocationContext,
  type ResearchRunCreate,
  type ResearchRunDetailDto,
  type ResearchRunStatus,
  type ResearchRunSummaryDto,
} from '@canonry/canonry-contracts'
import { CliError, isMachineFormat, usageError } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

/**
 * Statuses after which nothing more runs locally, so `--wait` returns: the
 * terminal ones, and `waiting-upstream`, whose remaining queries are upstream
 * jobs Canonry follows by id rather than work this process is doing.
 */
const SETTLED_RESEARCH_STATUSES = new Set<ResearchRunStatus>([
  ...TERMINAL_RESEARCH_RUN_STATUSES,
  ResearchRunStatuses['waiting-upstream'],
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
  scope?: ResearchRunCreate['scope']
  template?: ResearchRunCreate['template']
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
    scope: opts.scope,
    template: opts.template,
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

/** Accept only reviewed concrete destinations; retries reuse the key in the input file. */
export async function researchBatch(project: string, source: string, opts: { wait?: boolean; format?: string }): Promise<void> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf8')) as unknown
  } catch {
    throw usageError('Research batch input must be a readable JSON file (or - for stdin).', {
      message: 'Research batch input must be a readable JSON file (or - for stdin).',
      details: { command: 'research.batch' },
    })
  }
  const parsed = researchBatchCreateSchema.safeParse(raw)
  if (!parsed.success) {
    const message = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw usageError(`Invalid research batch: ${message}`, {
      message: `Invalid research batch: ${message}`,
      details: { command: 'research.batch' },
    })
  }
  const client = getClient()
  const started = await client.startResearchBatch(project, parsed.data)
  const runs = opts.wait
    ? await Promise.all(started.runs.map(run => SETTLED_RESEARCH_STATUSES.has(run.status)
      ? Promise.resolve(run)
      : pollResearchRun(client, project, run.id, true)))
    : started.runs
  if (opts.format === 'jsonl') {
    emitJsonl(runs.map(run => ({ project, ...run })))
  } else if (opts.format === 'json') {
    console.log(JSON.stringify({ runs }, null, 2))
  } else {
    console.log(`Research saved for ${runs.length} destinations (${runs.reduce((count, run) => count + run.totalQueries, 0)} queries).`)
    for (const run of runs) {
      if (opts.wait) printDetail(project, run)
      else printStarted(project, run)
    }
  }
}

export async function researchList(project: string, opts: { limit?: number; cursor?: string; format?: string }): Promise<void> {
  const client = getClient()
  const result = await client.listResearchRuns(project, opts.limit === undefined && opts.cursor === undefined ? undefined : { limit: opts.limit, cursor: opts.cursor })
  const { runs } = result
  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
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
  console.log('  ID                                    STATUS      QUERIES  PROVIDER / MODEL                  SCOPE                     CREATED')
  console.log('  ────────────────────────────────────  ──────────  ───────  ────────────────────────────────  ────────────────────────  ───────────────────────')
  for (const run of runs) {
    const model = run.resolvedModel ? `${run.provider} / ${run.resolvedModel}` : run.provider
    console.log(`  ${run.id.padEnd(36)}  ${run.status.padEnd(10)}  ${String(run.totalQueries).padStart(7)}  ${model.slice(0, 32).padEnd(32)}  ${formatScope(run.scope).slice(0, 24).padEnd(24)}  ${run.createdAt}`)
  }
  if (result.nextCursor) console.log(`\nNext page: canonry research list ${project} --cursor ${result.nextCursor}`)
}

export async function researchShow(project: string, runId: string, opts: { format?: string }): Promise<void> {
  const detail = await getClient().getResearchRun(project, runId)
  printDetail(project, detail, opts.format)
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
    if (SETTLED_RESEARCH_STATUSES.has(detail.status)) {
      if (!quiet) process.stderr.write('\n')
      return detail
    }
  }
}

function printStarted(project: string, run: ResearchRunSummaryDto): void {
  console.log(`Research run saved: ${run.id}`)
  console.log(`  Status:   ${run.status}`)
  console.log(`  Queries:  ${run.totalQueries}`)
  console.log(`  Scope:    ${formatScope(run.scope)}`)
  console.log(`  Location: ${run.location?.label ?? 'No location context'}`)
  console.log(`  Provider: ${run.provider}${run.resolvedModel ? ` / ${run.resolvedModel}` : ''}`)
  console.log(`  Inspect:  canonry research show ${project} ${run.id}`)
  console.log('  Nothing was added to tracked queries.')
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
  console.log(`  Scope:    ${formatScope(detail.scope)}`)
  console.log(`  Provider: ${detail.provider}${detail.resolvedModel ? ` / ${detail.resolvedModel}` : ''}`)
  if (detail.location) console.log(`  Location: ${detail.location.label}`)
  console.log(`  Results:  ${detail.completedQueries} completed, ${detail.failedQueries} failed, ${detail.totalQueries} total`)
  if (detail.error) console.log(`  Error:    ${detail.error}`)
  if (detail.status === ResearchRunStatuses['waiting-upstream']) console.log('  Waiting:  some queries wait on upstream jobs; each is followed by its job id and never submitted again.')
  console.log('  Nothing was added to tracked queries.')
  if (detail.queries.length === 0) return
  console.log('\n  QUERY                                                       STATUS      CITED  MENTIONED')
  for (const query of detail.queries) {
    // `n/m`: the answer service does not tie its sources to the answer, so citation was not measured.
    const cited = query.citationMeasured === false ? 'n/m' : query.citationState === CitationStates.cited ? 'yes' : query.citationState ? 'no' : '–'
    const mentioned = query.answerMentioned === null ? '–' : query.answerMentioned ? 'yes' : 'no'
    console.log(`  ${query.query.slice(0, 58).padEnd(58)}  ${query.status.padEnd(10)}  ${cited.padEnd(5)}  ${mentioned}`)
    if (query.error) console.log(`    Error: ${query.error}`)
    if (query.upstreamJobId) console.log(`    Upstream job: ${query.upstreamJobId}`)
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
    if (query.evidence) printEvidence(query.evidence)
  }
}

/** The shared label, lowercased to sit mid-sentence ("cost estimated by Canonry"). */
function midSentence(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1)
}
const RELATIONSHIP_LABELS = { 'explicit-citation': 'cited', 'answer-support': 'used for the answer', 'search-result': 'search result', 'page-read': 'page read' } as const

/** The answer-service evidence the API returned, one line per fact, the same facts the dashboard shows. */
function printEvidence(evidence: AnswerEvidence): void {
  const model = evidence.identity.disclosedModel
    ? `${evidence.identity.disclosedModel}${evidence.identity.disclosedModelKind === 'service-tier' ? ' (service tier)' : ''}`
    : 'not disclosed'
  console.log(`    Evidence: ${midSentence(answerCompletionLabel(evidence.completion.status))} · profile ${evidence.identity.route} · model ${model} · cost ${midSentence(answerCostBasisLabel(evidence.usage.cost))}`)
  const other = evidence.sources.filter(source => source.relationship === 'search-result' || source.relationship === 'page-read')
  for (const source of other) console.log(`      - (${RELATIONSHIP_LABELS[source.relationship]}) ${source.title ? `${source.title}: ` : ''}${source.url}`)
}

function formatScope(scope: ResearchRunSummaryDto['scope']): string {
  return scope ? `${scope.label} (${scope.kind})` : 'Project-wide'
}
