import { z } from 'zod'
import {
  sentimentSelectionSchema, sentimentEvidenceRequestSchema, sentimentCompareRequestSchema,
  sentimentSettingsUpdateSchema, sentimentBackfillSelectionSchema, sentimentBackfillRequestSchema,
} from '@ainyc/canonry-contracts'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, getStringArray, multiStringOption, requirePositional, requireProject, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import {
  showSentiment, showSentimentSettings, configureSentiment, showSentimentEvidence, compareSentiment,
  previewSentimentBackfill, submitSentimentBackfill, listSentimentJobs, showSentimentJob,
} from '../commands/sentiment.js'

const selectionOptions = {
  'run-id': stringOption(), 'query-id': stringOption(), revision: stringOption(), mode: stringOption(), 'query-class': stringOption(), scope: stringOption(),
  'scope-key': stringOption(), 'market-key': stringOption(), provider: stringOption(), model: stringOption(), location: stringOption(),
  'evaluation-definition-id': stringOption(),
}
const readSelectionOptions = { ...selectionOptions, 'run-ids': multiStringOption() }
const selectionHelp = 'Selection: --run-id <id> --query-id <frozen-query-id> --revision <n> --mode auto|simple|advanced --query-class branded|non-brand --scope project|property|group|market --scope-key <key> --market-key <key> --provider <provider> --model <id> --location <label> --evaluation-definition-id <id>. Branded and non-brand are separate populations; select exactly one class. Favorable % is favorable / (favorable + mixed + unfavorable), excluding factual and unjudged answers. The summary includes per-query scores. Reads use stored data only.'

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw usageError(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  return result.data
}
function selection(input: CliCommandInput): Record<string, unknown> {
  const names = { 'run-id': 'runId', 'query-id': 'queryId', revision: 'revision', mode: 'mode', 'query-class': 'queryClass', scope: 'scope', 'scope-key': 'scopeKey', 'market-key': 'marketKey', provider: 'provider', model: 'model', location: 'location', 'evaluation-definition-id': 'evaluationDefinitionId' }
  return Object.fromEntries(Object.entries(names).flatMap(([flag, field]) => {
    const value = getString(input.values, flag)
    return value === undefined ? [] : [[field, value]]
  }))
}
function readSelection(input: CliCommandInput): Record<string, unknown> {
  const runIds = getStringArray(input.values, 'run-ids')
  return { ...selection(input), ...(runIds ? { runIds } : {}) }
}
const readSelectionHelp = `${selectionHelp} To read an exact grouped location sweep, repeat --run-ids <id> for each run, instead of --run-id.`

function project(input: CliCommandInput, command: string): string {
  return requireProject(input, `sentiment.${command}`, `canonry sentiment ${command} <project> [options]`)
}

export const SENTIMENT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['sentiment', 'settings'], usage: 'canonry sentiment settings <project> [--format json]',
    help: 'Read configuration, experimental status, readiness and effective action permissions. No credentials are returned.',
    run: input => showSentimentSettings(project(input, 'settings'), input.format),
  },
  {
    path: ['sentiment', 'configure'], usage: 'canonry sentiment configure <project> --enabled true|false [--format json]',
    help: 'Install administrators can change project settings. Enabling processes future complete runs; historical runs require an explicit backfill. TypeSafe credentials are configured locally on the install.',
    options: { enabled: stringOption() },
    run: async input => {
      const enabled = getString(input.values, 'enabled')
      if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') throw usageError('--enabled must be true or false')
      if (enabled === undefined) throw usageError('Provide --enabled true or false explicitly')
      const request = parse(sentimentSettingsUpdateSchema, { enabled: enabled === 'true' })
      await configureSentiment(project(input, 'configure'), request, input.format)
    },
  },
  {
    path: ['sentiment', 'evidence'], usage: 'canonry sentiment evidence <project> [selection options] [--cursor <cursor>] [--limit 1..100] [--format json]',
    help: `${readSelectionHelp} Keep all selection fields, including the returned evaluationDefinitionId, when following a cursor. JSONL preserves the entire page envelope, including empty state and next cursor.`,
    options: { ...readSelectionOptions, cursor: stringOption(), limit: stringOption() },
    run: input => showSentimentEvidence(project(input, 'evidence'), parse(sentimentEvidenceRequestSchema, {
      ...readSelection(input), cursor: getString(input.values, 'cursor'), limit: getString(input.values, 'limit'),
    }), input.format),
  },
  {
    path: ['sentiment', 'compare'], usage: 'canonry sentiment compare <project> --from-run-id <id> --to-run-id <id> [selection options] [--format json]',
    help: `${selectionHelp} Complete matched coverage and compatible evaluators are required for a directional verdict.`,
    options: { ...selectionOptions, 'from-run-id': stringOption(), 'to-run-id': stringOption() },
    run: input => compareSentiment(project(input, 'compare'), parse(sentimentCompareRequestSchema, {
      ...selection(input), fromRunId: getString(input.values, 'from-run-id'), toRunId: getString(input.values, 'to-run-id'),
    }), input.format),
  },
  {
    path: ['sentiment', 'backfill'], usage: 'canonry sentiment backfill <project> --preview [--run-id <id> ... | --from <ISO> --to <ISO>] [selection options] | --preview-token <token> --idempotency-key <key> [--format json]',
    help: 'Preview reads stored sources only. Submit the returned frozen preview token with an explicit idempotency key; submission requires an install administrator. The same key and token returns the same job. A changed request with that key conflicts.',
    options: { ...selectionOptions, 'run-id': multiStringOption(), preview: { type: 'boolean' }, from: stringOption(), to: stringOption(), 'preview-token': stringOption(), 'idempotency-key': stringOption() },
    run: async input => {
      const name = project(input, 'backfill')
      const token = getString(input.values, 'preview-token')
      const key = getString(input.values, 'idempotency-key')
      const runIds = getStringArray(input.values, 'run-id')
      const from = getString(input.values, 'from'), to = getString(input.values, 'to')
      if (getBoolean(input.values, 'preview')) {
        if (token !== undefined || key !== undefined) throw usageError('--preview cannot be combined with --preview-token or --idempotency-key')
        if ((!runIds?.length && (!from || !to)) || (runIds?.length && (from || to))) throw usageError('Preview requires explicit --run-id values or both --from and --to')
        if (from && to && Date.parse(from) > Date.parse(to)) throw usageError('--from must be at or before --to')
        await previewSentimentBackfill(name, parse(sentimentBackfillSelectionSchema, { ...selection(input), runIds, from, to }), input.format)
      } else {
        if (runIds?.length || from || to || Object.keys(selection(input)).length) throw usageError('Submission takes only --preview-token and --idempotency-key; preview the selection first')
        await submitSentimentBackfill(name, parse(sentimentBackfillRequestSchema, { previewToken: token, idempotencyKey: key }), input.format)
      }
    },
  },
  {
    path: ['sentiment', 'jobs'], usage: 'canonry sentiment jobs <project> [--format json|jsonl]',
    run: input => listSentimentJobs(project(input, 'jobs'), input.format),
  },
  {
    path: ['sentiment', 'job'], usage: 'canonry sentiment job <project> <job-id> [--format json]',
    run: input => showSentimentJob(project(input, 'job'), requirePositional(input, 1, { command: 'sentiment.job', usage: 'canonry sentiment job <project> <job-id>', message: 'job ID is required' }), input.format),
  },
  {
    path: ['sentiment'], usage: 'canonry sentiment <project> [selection options] [--format json]',
    help: readSelectionHelp, options: readSelectionOptions,
    run: input => showSentiment(requireProject(input, 'sentiment', 'canonry sentiment <project> [options]'), parse(sentimentSelectionSchema, readSelection(input)), input.format),
  },
]
