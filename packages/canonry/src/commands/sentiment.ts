import type { z } from 'zod'
import type {
  SentimentSummaryRead, SentimentSettingsRead, SentimentBackfillSelection, sentimentSummaryRequestSchema, sentimentJobRequestSchema,
  sentimentSettingsUpdateSchema, sentimentEvidenceRequestSchema, sentimentCompareRequestSchema, sentimentBackfillRequestSchema,
} from '@ainyc/canonry-contracts'
import { formatPercent, RatioUnits } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat, type CliFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function machine(value: unknown, format: CliFormat): boolean {
  if (!isMachineFormat(format)) return false
  console.log(JSON.stringify(value, null, format === 'jsonl' ? 0 : 2))
  return true
}

function printSettings(value: SentimentSettingsRead): void {
  console.log(`Sentiment: ${value.enabled ? 'enabled' : 'disabled'} · ${value.ready ? 'ready' : 'unavailable'} · experimental`)
  console.log(`Evaluator: ${value.model} · definition: ${value.evaluationDefinitionId ?? 'not configured'} · epoch: ${value.enablementEpoch}`)
  for (const reason of value.readinessReasons) console.log(reason)
  console.log(`Actions: configure ${value.actions.configure ? 'allowed' : 'unavailable'}; backfill ${value.actions.backfill ? 'allowed' : 'unavailable'}`)
  console.log(value.disclosure)
}

export async function showSentiment(project: string, selection: z.infer<typeof sentimentSummaryRequestSchema>, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSentiment(project, selection)
  if (machine(value, format)) return
  printSummary(value)
}

function printSummary(value: SentimentSummaryRead): void {
  const label = value.selection.queryClass === 'branded' ? 'Branded' : 'Non-brand'
  console.log(`${label} sentiment: ${value.state}${value.provisional ? ' · provisional' : ''}`)
  if (value.reason) console.log(value.reason)
  console.log(`Favorable: ${value.score.favorableDisplay} · Mixed: ${value.score.mixedDisplay} · Unfavorable: ${value.score.unfavorableDisplay}`)
  console.log(`${label} favorable % = favorable / (favorable + mixed + unfavorable).`)
  console.log(`${value.coverage.judged} of ${value.coverage.selected} assessments judged · ${value.coverage.distinctSourceAnswers} distinct source answers`)
  console.log(`${value.coverage.eligibleAssessments} eligible assessments · ${value.coverage.unadmittedAssessments} not yet admitted`)
  console.log(`Source provider slots: ${value.coverage.completedProviderSlots} of ${value.coverage.expectedProviderSlots}`)
  console.log(`Evaluation definition: ${value.selection.evaluationDefinitionId ?? 'not measured'}`)
  if (value.state === 'complete' && value.coverage.judged === 0) console.log('No evaluative answers.')
  for (const [outcome, count] of Object.entries(value.coverage.counts)) if (count > 0) console.log(`  ${outcome}: ${count}`)
  if (value.score.interval) console.log(`Wilson 95% interval: ${formatPercent(value.score.interval.low, RatioUnits.fraction)} to ${formatPercent(value.score.interval.high, RatioUnits.fraction)}`)
  console.log(value.score.limitation)
  for (const row of value.queries) {
    console.log(`Query ${row.queryId}${row.executionNodeKey ? ` · node ${row.executionNodeKey}` : ''} · ${row.queryText} · ${row.queryClass}: Favorable ${row.score.favorableDisplay} · ${row.coverage.counts.favorable} favorable / ${row.coverage.judged} judged · ${row.state}${row.provisional ? ' · provisional' : ''}`)
    if (row.reason) console.log(`  ${row.reason}`)
    for (const assessment of row.assessments) {
      console.log(`  ${assessment.provider} · requested ${assessment.requestedModel ?? 'unavailable'} · served ${assessment.servedModel ?? 'unavailable'} · ${assessment.location ?? 'No location'} · ${assessment.subjectLabel}: ${assessment.outcome ?? assessment.state}`)
      console.log(`    source ${assessment.sourceSnapshotId} · assessment ${assessment.assessmentId ?? 'not measured'}`)
      if (assessment.reason) console.log(`    ${assessment.reason}`)
    }
  }
  for (const row of value.breakdowns) if (row.dimension !== 'query') console.log(`${row.dimension} ${row.label} · ${row.queryClass}: ${row.score.favorableDisplay} favorable · ${row.coverage.judged} of ${row.coverage.selected} judged`)
  if (value.queryPage) console.log(`Query rows: ${value.queries.length} of ${value.queryPage.total}`)
  if (value.queryPage?.nextCursor) console.log(`Next query cursor: ${value.queryPage.nextCursor}`)
}

export async function showSentimentSettings(project: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSentimentSettings(project)
  if (!machine(value, format)) printSettings(value)
}

export async function configureSentiment(project: string, request: z.infer<typeof sentimentSettingsUpdateSchema>, format: CliFormat): Promise<void> {
  const value = await createApiClient().configureSentiment(project, request)
  if (!machine(value, format)) printSettings(value)
}

export async function showSentimentEvidence(project: string, query: z.infer<typeof sentimentEvidenceRequestSchema>, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSentimentEvidence(project, query)
  // A page is one document: state, resolved selection and nextCursor must survive an empty page too.
  if (machine(value, format)) return
  console.log(`${value.selection.queryClass} sentiment evidence: ${value.state} · definition ${value.selection.evaluationDefinitionId ?? 'not measured'}`)
  for (const item of value.items) {
    console.log(`\n${item.subject.displayName} · ${item.outcome} · ${item.context.provider} · run ${item.runId}`)
    if (item.reason) console.log(item.reason)
    console.log(item.sourceText)
    for (const quote of item.conclusion) console.log(`Conclusion [${quote.start}:${quote.end}]: ${quote.text}`)
    if (item.complaint === null) console.log('Complaint: none selected')
    else for (const quote of item.complaint) console.log(`Complaint [${quote.start}:${quote.end}]: ${quote.text}`)
  }
  if (value.nextCursor) console.log(`Next cursor: ${value.nextCursor}`)
}

export async function compareSentiment(project: string, query: z.infer<typeof sentimentCompareRequestSchema>, format: CliFormat): Promise<void> {
  const value = await createApiClient().compareSentiment(project, query)
  if (machine(value, format)) return
  console.log(`Sentiment comparison: ${value.verdict ?? 'unavailable'}`)
  for (const reason of value.refusalReasons) console.log(reason)
  console.log(`Common units: ${value.commonUnits} · excluded from: ${value.excludedFrom} · excluded to: ${value.excludedTo}`)
  console.log(`Before: ${value.from.score.favorableDisplay} · ${value.from.coverage.judged} of ${value.from.coverage.selected} judged`)
  console.log(`After: ${value.to.score.favorableDisplay} · ${value.to.coverage.judged} of ${value.to.coverage.selected} judged`)
  console.log(value.limitation)
}

export async function previewSentimentBackfill(project: string, selection: SentimentBackfillSelection, format: CliFormat): Promise<void> {
  const value = await createApiClient().previewSentimentBackfill(project, selection)
  if (machine(value, format)) return
  console.log(`Stored backfill preview: ${value.eligibleAssessments} eligible assessments · ${value.alreadyClassified} already classified`)
  for (const skip of value.skipped) console.log(`  ${skip.runId}: ${skip.count} skipped (${skip.reason})`)
  console.log(`Estimated input tokens: ${value.estimatedInputTokens} · estimated USD: ${value.estimatedCostUsd ?? 'unknown'}`)
  console.log(value.estimateMethod)
  if (value.previewToken) console.log(`Preview token (expires ${value.expiresAt}): ${value.previewToken}`)
}

export async function submitSentimentBackfill(project: string, request: z.infer<typeof sentimentBackfillRequestSchema>, format: CliFormat): Promise<void> {
  const value = await createApiClient().submitSentimentBackfill(project, request)
  if (!machine(value, format)) console.log(`Sentiment job ${value.id}: ${value.state} · ${value.selected} selected assessments · epoch ${value.enablementEpoch}`)
}

export async function listSentimentJobs(project: string, format: CliFormat): Promise<void> {
  const value = await createApiClient().listSentimentJobs(project)
  if (format === 'jsonl') { emitJsonl(value.jobs.map(job => ({ project, ...job }))); return }
  if (machine(value, format)) return
  if (value.jobs.length === 0) console.log('No sentiment jobs.')
  for (const job of value.jobs) console.log(`${job.id}: ${job.state} · ${job.origin} · ${job.selected} selected · ${job.attemptCount} attempts · ${job.evaluationDefinitionId}`)
}

export async function showSentimentJob(project: string, jobId: string, page: Partial<z.infer<typeof sentimentJobRequestSchema>>, format: CliFormat): Promise<void> {
  const value = await createApiClient().getSentimentJob(project, jobId, page)
  if (machine(value, format)) return
  console.log(`Sentiment job ${value.id}: ${value.state} · ${value.origin} · epoch ${value.enablementEpoch}`)
  if (value.cancellationReason) console.log(value.cancellationReason)
  console.log(`${value.selected} selected assessments · definition ${value.evaluationDefinitionId}`)
  for (const [outcome, count] of Object.entries(value.counts)) if (count > 0) console.log(`  ${outcome}: ${count}`)
  if (value.attemptCount !== undefined) console.log(`Attempts: ${value.attempts.length} shown of ${value.attemptCount}, newest first`)
  for (const attempt of value.attempts) console.log(`Attempt ${attempt.id}: ${attempt.completedAt ?? 'in progress'} · usage ${attempt.usage.kind}${attempt.errorCode ? ` · ${attempt.errorCode}` : ''}`)
  if (value.nextAttemptCursor) console.log(`Next attempt cursor: ${value.nextAttemptCursor}`)
}
