import crypto from 'node:crypto'
import fs from 'node:fs'
import { parse } from 'yaml'
import {
  MeasurementEvidenceShapes,
  measurementChangesQuerySchema,
  measurementDataQualityQuerySchema,
  measurementDraftCollectionQuerySchema,
  measurementDiscoveryRequestSchema,
  measurementDiscoveryRuleSchema,
  measurementOverviewQuerySchema,
  measurementPlanDeactivateRequestSchema,
  measurementPlanInputSchema,
  measurementPortfolioSummaryQuerySchema,
  measurementPropertyCompetitorsQuerySchema,
  type MeasurementAnswerEvidence,
  type MeasurementAttributionEvidence,
  type MeasurementDiscoveryRequest,
  type MeasurementDiscoveryRule,
  type MeasurementEvidenceShape,
  type MeasurementOverviewResponse,
  type MeasurementPlanInput,
  type MeasurementPropertyEvidenceResponse,
  type MeasurementQueryClassFilter,
  type MetricValue,
  measurementPropertyQuestionsQuerySchema,
  measurementQuestionResultQuerySchema,
  measurementQuerySetUpsertRequestSchema,
  measurementQueryTemplateApplyRequestSchema,
  measurementQueryTemplateUpsertRequestSchema,
  visibilityReportRequestSchema,
  queryTrackingPreviewRequestSchema,
  queryTrackingCommitRequestSchema,
} from '@ainyc/canonry-contracts'
import { z } from 'zod'
import { isMachineFormat, systemError } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'
import { createApiClient } from '../client.js'
import { measurementDraftOperationSchema, runMeasurementDraftAction } from '../measurement-draft-actions.js'

function readPlan(source: string): MeasurementPlanInput {
  const content = source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8')
  const parsed: unknown = source.endsWith('.json') ? JSON.parse(content) : parse(content)
  return measurementPlanInputSchema.parse(parsed)
}

function readDiscoveryRule(source: string): MeasurementDiscoveryRule {
  const content = source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8')
  const parsed: unknown = source.endsWith('.json') ? JSON.parse(content) : parse(content)
  return measurementDiscoveryRuleSchema.parse(parsed)
}

/**
 * A compact, file-driven surface for Advanced Measurement operations that are
 * too structured to express safely as a long list of shell flags. Its JSON
 * response is the API response unchanged, so agents can use it as an API
 * replacement without post-processing.
 */
export const ADVANCED_MEASUREMENT_OPERATIONS = [
  'visibility',
  'query-workspace',
  'query-preview',
  'query-commit',
  'setup',
  'overview',
  'portfolio-summary',
  'property-questions',
  'question-result',
  'property-competitors',
  'changes',
  'data-quality',
  'draft',
  'draft-targets',
  'draft-assignments',
  'draft-groups',
  'draft-action',
  'deactivate',
  'query-sets',
  'query-set-get',
  'query-set-upsert',
  'query-set-delete',
  'query-templates',
  'query-template-upsert',
  'query-template-delete',
  'query-template-apply',
] as const

export type AdvancedMeasurementOperation = (typeof ADVANCED_MEASUREMENT_OPERATIONS)[number]

const advancedIdempotencyKeySchema = z.string().trim().min(1)
const advancedResourceIdSchema = z.string().trim().min(1)
const advancedEmptyInputSchema = z.object({}).strict()
const advancedQuerySetInputSchema = z.object({ setId: advancedResourceIdSchema }).strict()
const advancedQuerySetUpsertInputSchema = advancedQuerySetInputSchema.extend({
  request: measurementQuerySetUpsertRequestSchema,
}).strict()
const advancedQueryTemplateInputSchema = z.object({ templateId: advancedResourceIdSchema }).strict()
const advancedQueryTemplateUpsertInputSchema = advancedQueryTemplateInputSchema.extend({
  request: measurementQueryTemplateUpsertRequestSchema,
}).strict()
const advancedQueryTemplateApplyInputSchema = advancedQueryTemplateInputSchema.extend({
  request: measurementQueryTemplateApplyRequestSchema,
  idempotencyKey: advancedIdempotencyKeySchema,
}).strict()
const advancedDeactivateInputSchema = z.object({
  request: measurementPlanDeactivateRequestSchema,
  idempotencyKey: advancedIdempotencyKeySchema,
}).strict()

function readAdvancedMeasurementInput(source?: string): unknown {
  if (source === undefined) return {}
  const content = source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8')
  return JSON.parse(content) as unknown
}

const advancedMeasurementCollectionKeys = {
  'draft-targets': 'items',
  'draft-assignments': 'items',
  'draft-groups': 'items',
  'query-sets': 'querySets',
  'query-templates': 'templates',
} as const

function isAdvancedMeasurementCollectionOperation(
  operation: AdvancedMeasurementOperation,
): operation is keyof typeof advancedMeasurementCollectionKeys {
  return operation === 'draft-targets'
    || operation === 'draft-assignments'
    || operation === 'draft-groups'
    || operation === 'query-sets'
    || operation === 'query-templates'
}

function emitAdvancedMeasurementJsonl(operation: AdvancedMeasurementOperation, result: unknown): boolean {
  if (!isAdvancedMeasurementCollectionOperation(operation) || typeof result !== 'object' || result === null || Array.isArray(result)) return false
  const collectionKey = advancedMeasurementCollectionKeys[operation]
  const envelope = result as Record<string, unknown>
  const candidateRows = envelope[collectionKey]
  if (!Array.isArray(candidateRows)) return false
  const context: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(envelope)) {
    if (key !== collectionKey) context[key] = value
  }
  emitJsonl([{ kind: 'measurement-advanced-header', operation, ...context }])
  emitJsonl(candidateRows.map(row => row as unknown))
  return true
}

/** Execute one Advanced Measurement API operation through the public client. */
export async function runAdvancedMeasurementOperation(
  project: string,
  operation: AdvancedMeasurementOperation,
  source?: string,
  format?: string,
): Promise<void> {
  const input = readAdvancedMeasurementInput(source)
  const client = createApiClient()
  let result: unknown

  switch (operation) {
    case 'visibility':
      result = await client.getVisibilityReport(project, visibilityReportRequestSchema.parse(input))
      break
    case 'query-workspace':
      advancedEmptyInputSchema.parse(input)
      result = await client.getQueryTrackingWorkspace(project)
      break
    case 'query-preview':
      result = await client.previewQueryTracking(project, queryTrackingPreviewRequestSchema.parse(input))
      break
    case 'query-commit':
      result = await client.commitQueryTracking(project, queryTrackingCommitRequestSchema.parse(input))
      break
    case 'setup':
      advancedEmptyInputSchema.parse(input)
      result = await client.getMeasurementSetup(project)
      break
    case 'overview':
      result = await client.getMeasurementOverview(project, measurementOverviewQuerySchema.parse(input))
      break
    case 'portfolio-summary':
      result = await client.getMeasurementPortfolioSummary(project, measurementPortfolioSummaryQuerySchema.parse(input))
      break
    case 'property-questions':
      result = await client.getMeasurementPropertyQuestions(project, measurementPropertyQuestionsQuerySchema.parse(input))
      break
    case 'question-result':
      result = await client.getMeasurementQuestionResult(project, measurementQuestionResultQuerySchema.parse(input))
      break
    case 'property-competitors':
      result = await client.getMeasurementPropertyCompetitors(project, measurementPropertyCompetitorsQuerySchema.parse(input))
      break
    case 'changes':
      result = await client.getMeasurementChanges(project, measurementChangesQuerySchema.parse(input))
      break
    case 'data-quality':
      result = await client.getMeasurementDataQuality(project, measurementDataQualityQuerySchema.parse(input))
      break
    case 'draft':
      advancedEmptyInputSchema.parse(input)
      result = await client.getMeasurementPlanDraft(project)
      break
    case 'draft-targets':
      result = await client.getMeasurementDraftTargets(project, measurementDraftCollectionQuerySchema.parse(input))
      break
    case 'draft-assignments':
      result = await client.getMeasurementDraftAssignments(project, measurementDraftCollectionQuerySchema.parse(input))
      break
    case 'draft-groups':
      result = await client.getMeasurementDraftGroups(project, measurementDraftCollectionQuerySchema.parse(input))
      break
    case 'draft-action':
      result = await runMeasurementDraftAction(client, project, measurementDraftOperationSchema.parse(input))
      break
    case 'deactivate': {
      const parsed = advancedDeactivateInputSchema.parse(input)
      result = await client.deactivateMeasurementPlan(project, parsed.request, parsed.idempotencyKey)
      break
    }
    case 'query-sets':
      advancedEmptyInputSchema.parse(input)
      result = await client.listMeasurementQuerySets(project)
      break
    case 'query-set-get': {
      const parsed = advancedQuerySetInputSchema.parse(input)
      result = await client.getMeasurementQuerySet(project, parsed.setId)
      break
    }
    case 'query-set-upsert': {
      const parsed = advancedQuerySetUpsertInputSchema.parse(input)
      result = await client.upsertMeasurementQuerySet(project, parsed.setId, parsed.request)
      break
    }
    case 'query-set-delete': {
      const parsed = advancedQuerySetInputSchema.parse(input)
      result = await client.deleteMeasurementQuerySet(project, parsed.setId)
      break
    }
    case 'query-templates':
      advancedEmptyInputSchema.parse(input)
      result = await client.listMeasurementQueryTemplates(project)
      break
    case 'query-template-upsert': {
      const parsed = advancedQueryTemplateUpsertInputSchema.parse(input)
      result = await client.upsertMeasurementQueryTemplate(project, parsed.templateId, parsed.request)
      break
    }
    case 'query-template-delete': {
      const parsed = advancedQueryTemplateInputSchema.parse(input)
      result = await client.deleteMeasurementQueryTemplate(project, parsed.templateId)
      break
    }
    case 'query-template-apply': {
      const parsed = advancedQueryTemplateApplyInputSchema.parse(input)
      result = await client.applyMeasurementQueryTemplate(project, parsed.templateId, parsed.request, parsed.idempotencyKey)
      break
    }
  }

  if (format === 'jsonl' && emitAdvancedMeasurementJsonl(operation, result)) return
  console.log(JSON.stringify(result ?? null, null, 2))
}

export async function showMeasurementPlan(project: string, revision?: number): Promise<void> {
  const client = createApiClient()
  console.log(JSON.stringify(revision === undefined
    ? await client.getMeasurementPlan(project)
    : await client.getMeasurementPlanVersion(project, revision), null, 2))
}

export async function listMeasurementPlanVersions(project: string): Promise<void> {
  console.log(JSON.stringify(await createApiClient().listMeasurementPlanVersions(project), null, 2))
}

export async function publishMeasurementPlan(project: string, source: string): Promise<void> {
  const client = createApiClient()
  const plan = readPlan(source)
  const current = await client.getMeasurementPlan(project)
  console.log(JSON.stringify(await client.publishMeasurementPlan(project, {
    expectedActiveRevision: current.active?.revision ?? null,
    plan,
  }), null, 2))
}

export async function retireMeasurementPlanSegment(project: string, stableKey: string): Promise<void> {
  console.log(JSON.stringify(await createApiClient().retireMeasurementPlanSegment(project, stableKey), null, 2))
}

export interface MeasurementAssignmentApplyOptions {
  groupKeys?: string[]
  targetKeys?: string[]
  queryIds: string[]
  allProperties?: boolean
}

async function measurementAssignmentRequest(project: string, opts: MeasurementAssignmentApplyOptions) {
  const client = createApiClient()
  const current = await client.getMeasurementPlanDraft(project)
  if (!current.draft || !current.etag) {
    throw new Error(`Project "${project}" has no Advanced Measurement draft. Start setup in the dashboard or create a draft first.`)
  }
  const targetKeys = opts.allProperties
    ? current.draft.authoring.targets
      .filter(target => target.status === 'included')
      .map(target => target.stableKey)
    : opts.targetKeys
  return {
    client,
    request: {
      ...(targetKeys?.length ? { targetKeys } : {}),
      ...(opts.groupKeys?.length ? { groupKeys: opts.groupKeys } : {}),
      queryIds: opts.queryIds,
    },
  }
}

export async function previewMeasurementPlanAssignments(
  project: string,
  opts: MeasurementAssignmentApplyOptions,
): Promise<void> {
  const { client, request } = await measurementAssignmentRequest(project, opts)
  console.log(JSON.stringify(await client.previewMeasurementDraftAssignments(project, request), null, 2))
}

/** Preview the exact resolved audience and execution impact before one ETag-bound write. */
export async function applyMeasurementPlanAssignments(
  project: string,
  opts: MeasurementAssignmentApplyOptions,
): Promise<void> {
  const { client, request } = await measurementAssignmentRequest(project, opts)
  const preview = await client.previewMeasurementDraftAssignments(project, request)
  const result = await client.applyMeasurementDraftAssignments(
    project,
    request,
    crypto.randomUUID(),
    preview.draftEtag,
  )
  console.log(JSON.stringify({ preview, result }, null, 2))
}

/** Preview first, then atomically replace the named questions at that ETag. */
export async function replaceMeasurementPlanAssignments(
  project: string,
  opts: MeasurementAssignmentApplyOptions,
): Promise<void> {
  const { client, request } = await measurementAssignmentRequest(project, opts)
  const preview = await client.previewMeasurementDraftAssignments(project, request)
  const result = await client.replaceMeasurementDraftAssignments(
    project,
    request,
    crypto.randomUUID(),
    preview.draftEtag,
  )
  console.log(JSON.stringify({ preview, result }, null, 2))
}

function readGroupMembershipCsv(source: string): string {
  return source === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8')
}

export async function previewMeasurementPlanGroups(project: string, source: string): Promise<void> {
  const preview = await createApiClient().previewMeasurementDraftGroupMembership(project, {
    csv: readGroupMembershipCsv(source),
  })
  console.log(JSON.stringify(preview, null, 2))
}

export interface MeasurementGroupApplyOptions {
  acceptedRows?: number[]
  acceptAllMatched?: boolean
  acknowledgeSkipped?: boolean
}

/** Re-preview source and bind the confirmed mutation to the returned checksum and ETag. */
export async function applyMeasurementPlanGroups(
  project: string,
  source: string,
  opts: MeasurementGroupApplyOptions,
): Promise<void> {
  const client = createApiClient()
  const csv = readGroupMembershipCsv(source)
  const preview = await client.previewMeasurementDraftGroupMembership(project, { csv })
  if (preview.counts.needsAttention > 0 && !opts.acknowledgeSkipped) {
    throw new Error(
      `${preview.counts.needsAttention} CSV rows need attention. Correct them or add --acknowledge-skipped `
      + 'to apply only the selected matched rows.',
    )
  }
  const acceptedRows = opts.acceptAllMatched
    ? preview.rows.filter(row => row.status === 'matched').map(row => row.dataRow)
    : opts.acceptedRows ?? []
  if (acceptedRows.length === 0) throw new Error('No matched CSV rows were selected for apply.')
  const result = await client.applyMeasurementDraftGroupMembership(project, {
    csv,
    sourceChecksum: preview.sourceChecksum,
    previewChecksum: preview.previewChecksum,
    acceptedRows,
  }, crypto.randomUUID(), preview.draftEtag)
  console.log(JSON.stringify({ preview, result }, null, 2))
}

export async function discoverMeasurementTargets(
  project: string,
  sitemapUrl: string,
  ruleSource: string,
  maxUrls?: number,
): Promise<void> {
  const request: MeasurementDiscoveryRequest = measurementDiscoveryRequestSchema.parse({
    sitemapUrl,
    rule: readDiscoveryRule(ruleSource),
    ...(maxUrls === undefined ? {} : { maxUrls }),
  })
  console.log(JSON.stringify(await createApiClient().discoverMeasurementTargets(project, request), null, 2))
}

export async function showMeasurementReport(project: string, revision: number): Promise<void> {
  console.log(JSON.stringify(await createApiClient().getMeasurementReport(project, revision), null, 2))
}

/**
 * How a metric reads in a terminal. An unavailable one prints its reason and
 * never a percentage: "0%" is a measurement, "not measured" is the absence of
 * one, and the two must not look alike.
 */
const METRIC_REASONS: Record<string, string> = {
  plan_v1: 'not measured (setup update required)',
  no_completed_run: 'not measured (no completed run)',
  no_population: 'not measured (no questions of this type)',
  evidence_incomplete: 'not measured (evidence incomplete)',
  not_applicable: 'not measured (not applicable)',
}

function metricText(metric: MetricValue): string {
  if (metric.state === 'unavailable') return METRIC_REASONS[metric.reason] ?? `not measured (${metric.reason})`
  const percent = `${Math.round(metric.value * 100)}%`
  return metric.numerator === undefined || metric.denominator === undefined
    ? percent
    : `${metric.numerator} of ${metric.denominator} (${percent})`
}

export interface MeasurementPropertyOptions {
  targetKey: string
  queryClass?: MeasurementQueryClassFilter
  provider?: string
  location?: string
  runId?: string
  format?: string
}

/**
 * `canonry measurement-plan property <project> --target-key <key>` — one
 * Property out of the scoped overview. `--format json` is byte-for-byte the
 * endpoint's response so an agent can swap the two.
 */
export async function showMeasurementProperty(project: string, opts: MeasurementPropertyOptions): Promise<void> {
  const response = await createApiClient().getMeasurementOverview(project, {
    scope: 'property',
    targetKey: opts.targetKey,
    ...(opts.queryClass === undefined ? {} : { queryClass: opts.queryClass }),
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.location === undefined ? {} : { location: opts.location }),
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
  })

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  printMeasurementProperty(response)
}

function printMeasurementProperty(response: MeasurementOverviewResponse): void {
  const row = response.properties.items.at(0)
  const lines: string[] = []
  lines.push(`${response.scope.label} — ${response.queryClass} questions`)
  lines.push(`Measurement: ${response.measurement.state}${response.measurement.displayedRunId ? ` · run ${response.measurement.displayedRunId}` : ''}`)
  lines.push('')
  lines.push(`Mentioned  ${metricText(row ? row.mentionCoverage : response.metrics.mentionCoverage)}`)
  lines.push(`Cited      ${metricText(row ? row.citationCoverage : response.metrics.citationCoverage)}`)
  if (row && row.flags > 0) lines.push(`Flagged    ${row.flags} ${row.flags === 1 ? 'result needs' : 'results need'} review`)

  if (row && row.providers.length > 0) {
    lines.push('')
    lines.push(`${'Engine'.padEnd(14)}${'Mentioned'.padEnd(34)}Cited`)
    for (const provider of row.providers) {
      lines.push(`${provider.provider.padEnd(14)}${metricText(provider.mentionCoverage).padEnd(34)}${metricText(provider.citationCoverage)}`)
    }
  }
  console.log(lines.join('\n'))
}

export interface MeasurementPropertyEvidenceOptions {
  targetKey: string
  queryClass?: MeasurementQueryClassFilter
  provider?: string
  location?: string
  runId?: string
  shape?: MeasurementEvidenceShape
  cursor?: string
  limit?: number
  format?: string
}

interface ShapedPage<Row> {
  items: Row[]
  nextCursor: string | null
  totalEstimate?: number
}

type ShapedEvidencePage =
  | ({ shape: typeof MeasurementEvidenceShapes.sources } & ShapedPage<MeasurementAttributionEvidence>)
  | ({ shape: typeof MeasurementEvidenceShapes.answers } & ShapedPage<MeasurementAnswerEvidence>)

/**
 * Which page arrived IS the shape the endpoint served, so the header and the
 * rows under it are read off one value and cannot disagree. Neither page
 * present is a broken contract rather than an empty result, and saying so is
 * the only reading that is not a lie about the measurement.
 */
function shapedPage(response: MeasurementPropertyEvidenceResponse): ShapedEvidencePage {
  if (response.answers !== undefined) return { shape: MeasurementEvidenceShapes.answers, ...response.answers }
  if (response.evidence !== undefined) return { shape: MeasurementEvidenceShapes.sources, ...response.evidence }
  throw systemError('The measurement property evidence response carried neither an evidence nor an answers page.')
}

/**
 * `canonry measurement-plan property-evidence <project> --target-key <key>` —
 * one Property's evidence, cursor-paged exactly like the endpoint.
 */
export async function showMeasurementPropertyEvidence(
  project: string,
  opts: MeasurementPropertyEvidenceOptions,
): Promise<void> {
  const response = await createApiClient().getMeasurementPropertyEvidence(project, {
    targetKey: opts.targetKey,
    ...(opts.queryClass === undefined ? {} : { queryClass: opts.queryClass }),
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.location === undefined ? {} : { location: opts.location }),
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
    ...(opts.shape === undefined ? {} : { shape: opts.shape }),
    ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
  })

  if (opts.format === 'jsonl') {
    const page = shapedPage(response)
    // A bare row stream cannot tell an unmeasured Property from a measured one
    // with no evidence, drops the run and cursor a consumer needs to page, and
    // — now that a row can be a URL or a whole answer — cannot say what it is
    // streaming. The header line carries all three; the rows follow unchanged.
    emitJsonl([{
      kind: 'measurement-property-evidence-header' as const,
      shape: page.shape,
      property: response.property,
      queryClass: response.queryClass,
      measurement: response.measurement,
      totalEstimate: page.totalEstimate ?? null,
      nextCursor: page.nextCursor ?? null,
    }])
    emitJsonl(page.items)
    return
  }
  if (opts.format === 'json') {
    console.log(JSON.stringify(response, null, 2))
    return
  }
  printMeasurementPropertyEvidence(response)
}

/**
 * A signal that was never read prints as the absence it is. "no" is a
 * measurement; a bridged or legacy answer with no text to search is not one,
 * and the two must not look alike in a terminal either.
 */
function signalText(signal: boolean | null): string {
  if (signal === null) return 'not measured'
  return signal ? 'yes' : 'no'
}

function printMeasurementPropertyEvidence(response: MeasurementPropertyEvidenceResponse): void {
  const lines: string[] = []
  lines.push(`${response.property.label} — ${response.queryClass} questions`)
  if (response.measurement.state === 'not_measured') {
    // An empty page here is the absence of a measurement, not a measured zero.
    lines.push('Not measured yet. Run a measurement to collect source evidence.')
    console.log(lines.join('\n'))
    return
  }
  const page = shapedPage(response)
  const answerShape = page.shape === MeasurementEvidenceShapes.answers
  lines.push(`Measurement: ${response.measurement.state}${response.measurement.displayedRunId ? ` · run ${response.measurement.displayedRunId}` : ''}`)
  if (page.items.length === 0) {
    // Named for what was looked for. "No source evidence" under the answer
    // shape would report a Property whose answers cited nothing as a Property
    // with no answers at all.
    lines.push(answerShape
      ? 'No answers matched this Property in the displayed run.'
      : 'No source evidence matched this Property in the displayed run.')
    console.log(lines.join('\n'))
    return
  }
  lines.push(`${page.items.length} of ${page.totalEstimate ?? page.items.length} ${answerShape ? 'answers' : 'evidence rows'}`)
  lines.push('')
  if (page.shape === MeasurementEvidenceShapes.answers) {
    // Both signals on every row: a single cell that flipped between them would
    // leave a reader unable to tell which one they are looking at.
    lines.push(`${'Engine'.padEnd(12)}${'Question'.padEnd(40)}${'Mentioned'.padEnd(15)}${'Cited'.padEnd(8)}Sources`)
    for (const item of page.items) {
      lines.push(
        `${item.provider.padEnd(12)}${item.queryText.slice(0, 39).padEnd(40)}`
        + `${signalText(item.mentioned).padEnd(15)}${signalText(item.cited).padEnd(8)}${item.sources.length}`,
      )
    }
  } else {
    lines.push(`${'Match'.padEnd(14)}${'Engine'.padEnd(12)}${'Question'.padEnd(40)}URL`)
    for (const item of page.items) {
      lines.push(`${item.classification.padEnd(14)}${item.provider.padEnd(12)}${item.queryText.slice(0, 39).padEnd(40)}${item.sourceUrl}`)
    }
  }
  if (page.nextCursor) lines.push(`\nMore rows: --cursor ${page.nextCursor}`)
  console.log(lines.join('\n'))
}
