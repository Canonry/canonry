import { seoEvidenceQuerySchema, seoSyncInputSchema } from '@canonry/canonry-contracts'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import { getString, requirePositional, requireProject, requireStringOption, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import {
  showSeoContext, showSeoStatus, listSeoProfiles, showSeoProfile, setSeoProfile,
  prepareSeoRefresh, syncSeo, listSeoRuns, showSeoRun, cancelSeoRun,
  showSeoOperatorTask, reconcileSeoTask,
  showSeoOverview, showSeoKeywordMetrics, showSeoDomainIntelligence, showSeoRankedKeywords,
} from '../commands/seo.js'

const selectionOptions = { 'profile-id': stringOption(), 'run-id': stringOption(), limit: stringOption(), offset: stringOption() }
const evidenceHelp = 'Read saved SEO evidence only. Preserve --run-id when paging. Missing values remain unavailable; traffic is a provider estimate, not analytics. Profile scope preserves the Property/market and plan revision.'
function selection(input: CliCommandInput) {
  const result = seoEvidenceQuerySchema.safeParse({
    profileId: getString(input.values, 'profile-id'), runId: getString(input.values, 'run-id'),
    limit: getString(input.values, 'limit') === undefined ? undefined : Number(getString(input.values, 'limit')),
    offset: getString(input.values, 'offset') === undefined ? undefined : Number(getString(input.values, 'offset')),
  })
  if (!result.success) throw usageError(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  return result.data
}
function project(input: CliCommandInput): string { return requireProject(input, 'seo', 'canonry seo <command> <project> [options]') }
function id(input: CliCommandInput): string { return requirePositional(input, 1, { command: 'seo', usage: 'canonry seo <command> <project> <id>', message: 'profile or run ID is required' }) }

export const SEO_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['seo', 'operator', 'task'], usage: 'canonry seo operator task <task-id> [--format json]', access: 'stored',
    help: 'Host operator only. Read private upstream receipts and cost for reconciliation.',
    run: input => showSeoOperatorTask(requirePositional(input, 0, { command: 'seo.operator.task', usage: 'canonry seo operator task <task-id>', message: 'task ID is required' }), input.format),
  },
  {
    path: ['seo', 'operator', 'reconcile'], usage: 'canonry seo operator reconcile <task-id> --file <receipt-json|-> [--format json]', access: 'write',
    help: 'Host operator and seo.run only. Submit a verified upstream receipt with actualCostMicros, remoteTaskId, outcome and note. Never guesses settlement or retries the provider.',
    options: { file: stringOption() },
    run: input => reconcileSeoTask(requirePositional(input, 0, { command: 'seo.operator.reconcile', usage: 'canonry seo operator reconcile <task-id> --file <receipt-json|->', message: 'task ID is required' }), requireStringOption(input, 'file', { command: 'seo.operator.reconcile', usage: 'canonry seo operator reconcile <task-id> --file <receipt-json|->', message: '--file is required' }), input.format),
  },
  { path: ['seo', 'context'], usage: 'canonry seo context <project> [--format json]', access: 'stored', help: 'Read source readiness, supported exact scopes and effective permissions. No credentials or internal financial policy.', run: input => showSeoContext(project(input), input.format) },
  { path: ['seo', 'status'], usage: 'canonry seo status <project> [--format json]', access: 'stored', run: input => showSeoStatus(project(input), input.format) },
  { path: ['seo', 'profile', 'list'], usage: 'canonry seo profile list <project> [--format json|jsonl]', access: 'stored', run: input => listSeoProfiles(project(input), input.format) },
  { path: ['seo', 'profile', 'show'], usage: 'canonry seo profile show <project> <profile-id> [--format json]', access: 'stored', run: input => showSeoProfile(project(input), id(input), input.format) },
  {
    path: ['seo', 'profile', 'set'], usage: 'canonry seo profile set <project> <profile-id> --file <json-path|-> [--format json]', access: 'write',
    help: 'Create or replace the complete profile. JSON includes name, connectionId, capabilities, targets, keywords, locationCode, languageCode, limit and scope. Advanced scope pins expectedPlanRevision. Does not start provider work or change host spending policy.',
    options: { file: stringOption() },
    run: input => setSeoProfile(project(input), id(input), requireStringOption(input, 'file', { command: 'seo.profile.set', usage: 'canonry seo profile set <project> <id> --file <json-path|->', message: '--file is required' }), input.format),
  },
  {
    path: ['seo', 'refresh-intent'], usage: 'canonry seo refresh-intent <project> <profile-id> [--format json]', access: 'stored',
    help: 'Prepare a bounded refresh from a saved profile without provider calls. Submit the returned token with seo sync and an explicit idempotency key.',
    run: input => prepareSeoRefresh(project(input), id(input), input.format),
  },
  {
    path: ['seo', 'sync'], usage: 'canonry seo sync <project> --intent-token <token> --idempotency-key <key> [--format json]', access: 'write',
    help: 'Start the reviewed refresh under the host policy. May call a paid source. Exact retries reuse the same intent and key; a changed request conflicts. Read seo run show for progress.',
    options: { 'intent-token': stringOption(), 'idempotency-key': stringOption() },
    run: input => {
      const parsed = seoSyncInputSchema.safeParse({ quoteToken: getString(input.values, 'intent-token'), idempotencyKey: getString(input.values, 'idempotency-key') })
      if (!parsed.success) throw usageError('Provide --intent-token and --idempotency-key from the reviewed refresh.')
      return syncSeo(project(input), parsed.data, input.format)
    },
  },
  { path: ['seo', 'runs'], usage: 'canonry seo runs <project> [--profile-id <id>] [--format json|jsonl]', access: 'stored', options: { 'profile-id': stringOption() }, run: input => listSeoRuns(project(input), input.format, getString(input.values, 'profile-id')) },
  { path: ['seo', 'run', 'show'], usage: 'canonry seo run show <project> <run-id> [--format json]', access: 'stored', help: 'Read the stored task outcomes and bounded evidence preview.', run: input => showSeoRun(project(input), id(input), input.format) },
  { path: ['seo', 'run', 'cancel'], usage: 'canonry seo run cancel <project> <run-id> [--format json]', access: 'write', help: 'Stop undispatched tasks. Accepted source requests may still settle; cancellation never implies a refund.', run: input => cancelSeoRun(project(input), id(input), input.format) },
  { path: ['seo', 'overview'], usage: 'canonry seo overview <project> [--profile-id <id>] [--run-id <id>] [--format json]', access: 'stored', options: selectionOptions, help: evidenceHelp, run: input => showSeoOverview(project(input), selection(input), input.format) },
  { path: ['seo', 'keyword-metrics'], usage: 'canonry seo keyword-metrics <project> [--profile-id <id>] [--run-id <id>] [--limit <n>] [--offset <n>] [--format json]', access: 'stored', options: selectionOptions, help: evidenceHelp, run: input => showSeoKeywordMetrics(project(input), selection(input), input.format) },
  { path: ['seo', 'domain-intelligence'], usage: 'canonry seo domain-intelligence <project> [--profile-id <id>] [--run-id <id>] [--limit <n>] [--offset <n>] [--format json]', access: 'stored', options: selectionOptions, help: evidenceHelp, run: input => showSeoDomainIntelligence(project(input), selection(input), input.format) },
  { path: ['seo', 'ranked-keywords'], usage: 'canonry seo ranked-keywords <project> [--profile-id <id>] [--run-id <id>] [--limit <n>] [--offset <n>] [--format json]', access: 'stored', options: selectionOptions, help: evidenceHelp, run: input => showSeoRankedKeywords(project(input), selection(input), input.format) },
]
