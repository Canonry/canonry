import { and, asc, eq, gte, lte } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { parseJsonColumn, queries, querySnapshots, runs } from '@ainyc/canonry-db'
import {
  CitationStates,
  parseInclusiveEndMs,
  RunKinds,
  runStatusSchema,
  runTriggerSchema,
  validationError,
  type CitationState,
  type GroundingSource,
  type ResultsExportDto,
  type ResultsExportFormat,
  type ResultsExportRecord,
} from '@ainyc/canonry-contracts'
import { notProbeRun, resolveProject } from './helpers.js'

const CSV_COLUMNS = [
  'export_schema_version',
  'project_id',
  'project_name',
  'project_display_name',
  'canonical_domain',
  'run_id',
  'run_kind',
  'run_status',
  'run_trigger',
  'run_created_at',
  'run_started_at',
  'run_finished_at',
  'snapshot_id',
  'snapshot_created_at',
  'query_id',
  'query',
  'provider',
  'model',
  'location',
  'citation_state',
  'cited',
  'answer_mentioned',
  'mention_state',
  'cited_domains_json',
  'competitor_overlap_json',
  'recommended_competitors_json',
  'answer_text',
  'grounding_sources_json',
  'search_queries_json',
] as const

function parseFormat(value: string | undefined): ResultsExportFormat {
  if (value === undefined || value === '' || value === 'json') return 'json'
  if (value === 'csv') return 'csv'
  throw validationError('"format" must be "json" or "csv"')
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === '') return false
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw validationError(`"${name}" must be "true" or "false"`)
}

function parseDateBounds(since: string | undefined, until: string | undefined): {
  sinceIso: string | null
  untilIso: string | null
} {
  let sinceIso: string | null = null
  let untilIso: string | null = null

  if (since !== undefined && since !== '') {
    const ms = Date.parse(since)
    if (Number.isNaN(ms)) throw validationError('"since" must be an ISO 8601 date/time')
    sinceIso = new Date(ms).toISOString()
  }
  if (until !== undefined && until !== '') {
    const ms = parseInclusiveEndMs(until)
    if (ms === null) throw validationError('"until" must be an ISO 8601 date/time')
    untilIso = new Date(ms).toISOString()
  }
  if (sinceIso !== null && untilIso !== null && untilIso < sinceIso) {
    throw validationError('"until" must be on or after "since"')
  }
  return { sinceIso, untilIso }
}

function readEvidence(rawResponse: string | null): {
  groundingSources: GroundingSource[]
  searchQueries: string[]
} {
  const parsed = parseJsonColumn<Record<string, unknown>>(rawResponse, {})
  const groundingSources = Array.isArray(parsed.groundingSources)
    ? parsed.groundingSources
      .filter((source): source is { uri: string; title?: string } =>
        typeof source === 'object' && source !== null && typeof (source as { uri?: unknown }).uri === 'string',
      )
      .map(source => ({ uri: source.uri, title: typeof source.title === 'string' ? source.title : '' }))
    : []
  const searchQueries = Array.isArray(parsed.searchQueries)
    ? parsed.searchQueries.filter((query): query is string => typeof query === 'string')
    : []
  return { groundingSources, searchQueries }
}

function recordMentionState(answerMentioned: boolean | null): ResultsExportRecord['mentionState'] {
  if (answerMentioned === null) return null
  return answerMentioned ? 'mentioned' : 'not-mentioned'
}

function spreadsheetSafe(value: string): string {
  return /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return ''
  const text = typeof value === 'string' ? spreadsheetSafe(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function renderResultsExportCsv(report: ResultsExportDto): string {
  const rows = report.records.map(record => [
    report.schemaVersion,
    report.project.id,
    report.project.name,
    report.project.displayName,
    report.project.canonicalDomain,
    record.runId,
    record.runKind,
    record.runStatus,
    record.runTrigger,
    record.runCreatedAt,
    record.runStartedAt,
    record.runFinishedAt,
    record.snapshotId,
    record.snapshotCreatedAt,
    record.queryId,
    record.query,
    record.provider,
    record.model,
    record.location,
    record.citationState,
    record.cited,
    record.answerMentioned,
    record.mentionState,
    JSON.stringify(record.citedDomains),
    JSON.stringify(record.competitorOverlap),
    JSON.stringify(record.recommendedCompetitors),
    record.answerText,
    JSON.stringify(record.groundingSources),
    JSON.stringify(record.searchQueries),
  ].map(csvCell).join(','))
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n'
}

function filenameFor(projectName: string, format: ResultsExportFormat): string {
  const safeName = projectName.replace(/[^\w.-]+/gi, '_') || 'project'
  const date = new Date().toISOString().slice(0, 10)
  return `canonry-results-${safeName}-${date}.${format}`
}

export async function resultsExportRoutes(app: FastifyInstance) {
  app.get<{
    Params: { name: string }
    Querystring: { format?: string; since?: string; until?: string; includeProbes?: string }
  }>('/projects/:name/results/export', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const format = parseFormat(request.query.format)
    const includeProbes = parseBoolean(request.query.includeProbes, 'includeProbes')
    const { sinceIso, untilIso } = parseDateBounds(request.query.since, request.query.until)

    const conditions = [
      eq(runs.projectId, project.id),
      eq(runs.kind, RunKinds['answer-visibility']),
      ...(includeProbes ? [] : [notProbeRun()]),
      ...(sinceIso ? [gte(runs.createdAt, sinceIso)] : []),
      ...(untilIso ? [lte(runs.createdAt, untilIso)] : []),
    ]
    // The whole result set is materialized in memory (rows + per-row
    // rawResponse parse) — no pagination or streaming. Single-tenant scale
    // keeps this small today; past ~100k snapshots this endpoint needs a
    // streamed/row-windowed rewrite before it needs anything else.
    const rows = app.db
      .select({
        runId: runs.id,
        runStatus: runs.status,
        runTrigger: runs.trigger,
        runCreatedAt: runs.createdAt,
        runStartedAt: runs.startedAt,
        runFinishedAt: runs.finishedAt,
        snapshotId: querySnapshots.id,
        snapshotCreatedAt: querySnapshots.createdAt,
        queryId: querySnapshots.queryId,
        queryText: querySnapshots.queryText,
        currentQuery: queries.query,
        provider: querySnapshots.provider,
        model: querySnapshots.model,
        location: querySnapshots.location,
        citationState: querySnapshots.citationState,
        answerMentioned: querySnapshots.answerMentioned,
        citedDomains: querySnapshots.citedDomains,
        competitorOverlap: querySnapshots.competitorOverlap,
        recommendedCompetitors: querySnapshots.recommendedCompetitors,
        answerText: querySnapshots.answerText,
        rawResponse: querySnapshots.rawResponse,
      })
      .from(querySnapshots)
      .innerJoin(runs, eq(querySnapshots.runId, runs.id))
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(and(...conditions))
      .orderBy(asc(runs.createdAt), asc(runs.id), asc(querySnapshots.createdAt), asc(querySnapshots.id))
      .all()

    const records: ResultsExportRecord[] = rows.map(row => {
      const evidence = readEvidence(row.rawResponse)
      const citationState: CitationState = row.citationState === CitationStates.cited
        ? CitationStates.cited
        : CitationStates['not-cited']
      return {
        runId: row.runId,
        runKind: RunKinds['answer-visibility'],
        runStatus: runStatusSchema.parse(row.runStatus),
        runTrigger: runTriggerSchema.parse(row.runTrigger),
        runCreatedAt: row.runCreatedAt,
        runStartedAt: row.runStartedAt,
        runFinishedAt: row.runFinishedAt,
        snapshotId: row.snapshotId,
        snapshotCreatedAt: row.snapshotCreatedAt,
        queryId: row.queryId,
        query: row.queryText ?? row.currentQuery,
        provider: row.provider,
        model: row.model,
        location: row.location,
        citationState,
        cited: citationState === CitationStates.cited,
        answerMentioned: row.answerMentioned,
        mentionState: recordMentionState(row.answerMentioned),
        citedDomains: row.citedDomains,
        competitorOverlap: row.competitorOverlap,
        recommendedCompetitors: row.recommendedCompetitors,
        answerText: row.answerText,
        groundingSources: evidence.groundingSources,
        searchQueries: evidence.searchQueries,
      }
    })

    const dto: ResultsExportDto = {
      schemaVersion: 'canonry.results-export/v1',
      generatedAt: new Date().toISOString(),
      project: {
        id: project.id,
        name: project.name,
        displayName: project.displayName,
        canonicalDomain: project.canonicalDomain,
        country: project.country,
        language: project.language,
      },
      filters: {
        since: request.query.since || null,
        until: request.query.until || null,
        includeProbes,
      },
      recordCount: records.length,
      records,
    }

    reply.header('Content-Disposition', `attachment; filename="${filenameFor(project.name, format)}"`)
    reply.header('Cache-Control', 'private, no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    if (format === 'csv') {
      reply.type('text/csv; charset=utf-8')
      return reply.send(renderResultsExportCsv(dto))
    }
    reply.type('application/json; charset=utf-8')
    return reply.send(dto)
  })
}
