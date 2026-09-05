import type { MeasurementEvidenceShape, MeasurementQueryClassFilter } from '@ainyc/canonry-contracts'
import {
  ADVANCED_MEASUREMENT_OPERATIONS,
  applyMeasurementPlanAssignments,
  applyMeasurementPlanGroups,
  discoverMeasurementTargets,
  listMeasurementPlanVersions,
  publishMeasurementPlan,
  previewMeasurementPlanGroups,
  previewMeasurementPlanAssignments,
  replaceMeasurementPlanAssignments,
  retireMeasurementPlanSegment,
  showMeasurementPlan,
  showMeasurementProperty,
  showMeasurementPropertyEvidence,
  showMeasurementReport,
  runAdvancedMeasurementOperation,
} from '../commands/measurement-plan.js'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  getStringArray,
  multiStringOption,
  requireProject,
  requireStringOption,
  stringOption,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const QUERY_CLASSES: readonly MeasurementQueryClassFilter[] = ['all', 'branded', 'non-brand']
const EVIDENCE_SHAPES: readonly MeasurementEvidenceShape[] = ['sources', 'answers']

function queryClassOption(input: CliCommandInput): MeasurementQueryClassFilter | undefined {
  const value = getString(input.values, 'query-class')
  if (value === undefined) return undefined
  const match = QUERY_CLASSES.find(candidate => candidate === value)
  if (!match) throw usageError(`--query-class must be one of ${QUERY_CLASSES.join(', ')}`)
  return match
}

function shapeOption(input: CliCommandInput): MeasurementEvidenceShape | undefined {
  const value = getString(input.values, 'shape')
  if (value === undefined) return undefined
  const match = EVIDENCE_SHAPES.find(candidate => candidate === value)
  if (!match) throw usageError(`--shape must be one of ${EVIDENCE_SHAPES.join(', ')}`)
  return match
}

/** Filters every per-Property read shares, so the two commands cannot drift apart. */
function propertyScope(input: CliCommandInput, command: string, usage: string) {
  return {
    targetKey: requireStringOption(input, 'target-key', { command, usage, message: '--target-key is required' }),
    queryClass: queryClassOption(input),
    provider: getString(input.values, 'provider'),
    location: getString(input.values, 'location'),
    runId: getString(input.values, 'run-id'),
    format: input.format,
  }
}

const PROPERTY_SCOPE_OPTIONS = {
  'target-key': stringOption(),
  'query-class': stringOption(),
  provider: stringOption(),
  location: stringOption(),
  'run-id': stringOption(),
}

const ASSIGNMENT_AUDIENCE_OPTIONS = {
  group: multiStringOption(),
  'target-key': multiStringOption(),
  'all-properties': { type: 'boolean' as const },
  'query-id': multiStringOption(),
}

function assignmentAudience(input: CliCommandInput, command: string, usage: string) {
  const project = requireProject(input, command, usage)
  const groupKeys = getStringArray(input.values, 'group')?.map(value => value.trim()).filter(Boolean)
  const targetKeys = getStringArray(input.values, 'target-key')?.map(value => value.trim()).filter(Boolean)
  const queryIds = getStringArray(input.values, 'query-id')?.map(value => value.trim()).filter(Boolean) ?? []
  const allProperties = getBoolean(input.values, 'all-properties')
  if (queryIds.length === 0) throw usageError(`Error: at least one --query-id is required\nUsage: ${usage}`)
  if (allProperties && ((groupKeys?.length ?? 0) > 0 || (targetKeys?.length ?? 0) > 0)) {
    throw usageError(`Error: --all-properties cannot be combined with --group or --target-key\nUsage: ${usage}`)
  }
  if (!allProperties && (groupKeys?.length ?? 0) === 0 && (targetKeys?.length ?? 0) === 0) {
    throw usageError(`Error: select at least one --group, --target-key, or --all-properties\nUsage: ${usage}`)
  }
  return { project, options: { groupKeys, targetKeys, queryIds, allProperties } }
}

function advancedMeasurementOperation(value: string | undefined, usage: string) {
  const operation = ADVANCED_MEASUREMENT_OPERATIONS.find(candidate => candidate === value)
  if (operation) return operation
  throw usageError(`Error: unsupported Advanced Measurement operation: ${value ?? '(none)'}\nUsage: ${usage}`)
}

export const MEASUREMENT_PLAN_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['measurement-plan', 'visibility'],
    usage: 'canonry measurement-plan visibility <project> [<json|->] [--format json]',
    run: input => runAdvancedMeasurementOperation(
      requireProject(input, 'measurement-plan.visibility', 'canonry measurement-plan visibility <project> [<json|->] [--format json]'),
      'visibility', input.positionals[1], input.format,
    ),
  },
  { path: ['measurement-plan', 'show'], usage: 'canonry measurement-plan show <project> [--revision N] [--format json]', options: { revision: stringOption() }, run: async input => {
    const value = getString(input.values, 'revision')
    const revision = value === undefined ? undefined : Number(value)
    if (revision !== undefined && (!Number.isInteger(revision) || revision <= 0)) throw usageError('--revision must be a positive integer')
    await showMeasurementPlan(requireProject(input, 'measurement-plan.show', 'canonry measurement-plan show <project> [--revision N]'), revision)
  } },
  { path: ['measurement-plan', 'versions'], usage: 'canonry measurement-plan versions <project> [--format json]', run: input => listMeasurementPlanVersions(requireProject(input, 'measurement-plan.versions', 'canonry measurement-plan versions <project>')) },
  { path: ['measurement-plan', 'publish'], usage: 'canonry measurement-plan publish <project> <yaml|json|-> [--format json] (legacy schema v1 only; refuses over an active v2 plan; for Advanced Measurement use: canonry measurement-plan advanced <project> draft-action)', run: input => {
    const project = requireProject(input, 'measurement-plan.publish', 'canonry measurement-plan publish <project> <yaml|json|->')
    const source = input.positionals[1]
    if (!source) throw usageError('plan file path or - is required')
    return publishMeasurementPlan(project, source)
  } },
  { path: ['measurement-plan', 'retire'], usage: 'canonry measurement-plan retire <project> <stable-key> [--format json]', run: input => {
    const project = requireProject(input, 'measurement-plan.retire', 'canonry measurement-plan retire <project> <stable-key>')
    const stableKey = input.positionals[1]
    if (!stableKey) throw usageError('stable segment key is required')
    return retireMeasurementPlanSegment(project, stableKey)
  } },
  {
    path: ['measurement-plan', 'advanced'],
    usage: 'canonry measurement-plan advanced <project> <operation> [<json|->] [--format json|jsonl]',
    run: input => {
      const usage = 'canonry measurement-plan advanced <project> <operation> [<json|->] [--format json|jsonl]'
      const project = requireProject(input, 'measurement-plan.advanced', usage)
      const operation = advancedMeasurementOperation(input.positionals[1], usage)
      return runAdvancedMeasurementOperation(project, operation, input.positionals[2], input.format)
    },
  },
  {
    path: ['measurement-plan', 'assignments', 'preview'],
    usage: 'canonry measurement-plan assignments preview <project> [--group KEY ...] [--target-key KEY ... | --all-properties] --query-id ID [--query-id ID ...] [--format json]',
    options: ASSIGNMENT_AUDIENCE_OPTIONS,
    run: input => {
      const usage = 'canonry measurement-plan assignments preview <project> [--group KEY ...] [--target-key KEY ... | --all-properties] --query-id ID [--query-id ID ...]'
      const { project, options } = assignmentAudience(input, 'measurement-plan.assignments.preview', usage)
      return previewMeasurementPlanAssignments(project, options)
    },
  },
  {
    path: ['measurement-plan', 'assignments', 'apply'],
    usage: 'canonry measurement-plan assignments apply <project> [--group KEY ...] [--target-key KEY ... | --all-properties] --query-id ID [--query-id ID ...] [--format json]',
    options: ASSIGNMENT_AUDIENCE_OPTIONS,
    run: input => {
      const usage = 'canonry measurement-plan assignments apply <project> [--group KEY ...] [--target-key KEY ... | --all-properties] --query-id ID [--query-id ID ...]'
      const { project, options } = assignmentAudience(input, 'measurement-plan.assignments.apply', usage)
      return applyMeasurementPlanAssignments(project, options)
    },
  },
  {
    path: ['measurement-plan', 'assignments', 'replace'],
    usage: 'canonry measurement-plan assignments replace <project> [--group KEY ...] [--target-key KEY ... | --all-properties] --query-id ID [--query-id ID ...] --confirm [--format json]',
    options: { ...ASSIGNMENT_AUDIENCE_OPTIONS, confirm: { type: 'boolean' } },
    run: input => {
      const usage = 'canonry measurement-plan assignments replace <project> [--group KEY ...] [--target-key KEY ... | --all-properties] --query-id ID [--query-id ID ...] --confirm'
      if (!getBoolean(input.values, 'confirm')) throw usageError(`Error: --confirm is required\nUsage: ${usage}`)
      const { project, options } = assignmentAudience(input, 'measurement-plan.assignments.replace', usage)
      return replaceMeasurementPlanAssignments(project, options)
    },
  },
  {
    path: ['measurement-plan', 'groups', 'preview'],
    usage: 'canonry measurement-plan groups preview <project> <csv|-> [--format json]',
    run: input => {
      const usage = 'canonry measurement-plan groups preview <project> <csv|->'
      const project = requireProject(input, 'measurement-plan.groups.preview', usage)
      const source = input.positionals[1]
      if (!source) throw usageError(`Error: CSV file path or - is required\nUsage: ${usage}`)
      return previewMeasurementPlanGroups(project, source)
    },
  },
  {
    path: ['measurement-plan', 'groups', 'apply'],
    usage: 'canonry measurement-plan groups apply <project> <csv|-> --confirm [--accept-row N ... | --accept-all-matched] [--acknowledge-skipped] [--format json]',
    options: {
      confirm: { type: 'boolean' },
      'accept-row': multiStringOption(),
      'accept-all-matched': { type: 'boolean' },
      'acknowledge-skipped': { type: 'boolean' },
    },
    run: input => {
      const usage = 'canonry measurement-plan groups apply <project> <csv|-> --confirm [--accept-row N ... | --accept-all-matched] [--acknowledge-skipped]'
      const project = requireProject(input, 'measurement-plan.groups.apply', usage)
      const source = input.positionals[1]
      if (!source) throw usageError(`Error: CSV file path or - is required\nUsage: ${usage}`)
      if (!getBoolean(input.values, 'confirm')) throw usageError(`Error: --confirm is required\nUsage: ${usage}`)
      const acceptAllMatched = getBoolean(input.values, 'accept-all-matched')
      const rowValues = getStringArray(input.values, 'accept-row') ?? []
      if (acceptAllMatched === (rowValues.length > 0)) {
        throw usageError(`Error: choose exactly one of --accept-row or --accept-all-matched\nUsage: ${usage}`)
      }
      const acceptedRows = rowValues.map(value => Number(value))
      if (acceptedRows.some(row => !Number.isSafeInteger(row) || row < 1)) {
        throw usageError(`Error: --accept-row must be a positive integer\nUsage: ${usage}`)
      }
      return applyMeasurementPlanGroups(project, source, {
        acceptedRows,
        acceptAllMatched,
        acknowledgeSkipped: getBoolean(input.values, 'acknowledge-skipped'),
      })
    },
  },
  {
    path: ['measurement-plan', 'discover'],
    usage: 'canonry measurement-plan discover <project> --sitemap-url <url> --rule <yaml|json|-> [--max-urls N] [--format json]',
    options: { 'sitemap-url': stringOption(), rule: stringOption(), 'max-urls': stringOption() },
    run: input => {
      const usage = 'canonry measurement-plan discover <project> --sitemap-url <url> --rule <yaml|json|-> [--max-urls N]'
      const project = requireProject(input, 'measurement-plan.discover', usage)
      const sitemapUrl = requireStringOption(input, 'sitemap-url', {
        command: 'measurement-plan.discover', usage, message: '--sitemap-url is required',
      })
      const rule = requireStringOption(input, 'rule', {
        command: 'measurement-plan.discover', usage, message: '--rule is required',
      })
      const maxUrlsValue = getString(input.values, 'max-urls')
      const maxUrls = maxUrlsValue === undefined ? undefined : Number(maxUrlsValue)
      if (maxUrls !== undefined && (!Number.isInteger(maxUrls) || maxUrls < 1 || maxUrls > 10_000)) {
        throw usageError('--max-urls must be an integer from 1 to 10000')
      }
      return discoverMeasurementTargets(project, sitemapUrl, rule, maxUrls)
    },
  },
  {
    path: ['measurement-plan', 'report'],
    usage: 'canonry measurement-plan report <project> --revision N [--format json]',
    options: { revision: stringOption() },
    run: input => {
      const project = requireProject(input, 'measurement-plan.report', 'canonry measurement-plan report <project> --revision N')
      const value = getString(input.values, 'revision')
      const revision = value === undefined ? undefined : Number(value)
      if (revision === undefined || !Number.isInteger(revision) || revision <= 0) {
        throw usageError('--revision must be a positive integer')
      }
      return showMeasurementReport(project, revision)
    },
  },
  {
    path: ['measurement-plan', 'property'],
    usage: 'canonry measurement-plan property <project> --target-key <key> [--query-class all|branded|non-brand] [--provider <p>] [--location <l>] [--run-id <id>] [--format json]',
    options: PROPERTY_SCOPE_OPTIONS,
    run: input => {
      const usage = 'canonry measurement-plan property <project> --target-key <key>'
      const project = requireProject(input, 'measurement-plan.property', usage)
      return showMeasurementProperty(project, propertyScope(input, 'measurement-plan.property', usage))
    },
  },
  {
    path: ['measurement-plan', 'property-evidence'],
    usage: 'canonry measurement-plan property-evidence <project> --target-key <key> [--query-class all|branded|non-brand] [--provider <p>] [--location <l>] [--run-id <id>] [--shape sources|answers] [--cursor <c>] [--limit N] [--format json|jsonl]',
    options: { ...PROPERTY_SCOPE_OPTIONS, shape: stringOption(), cursor: stringOption(), limit: stringOption() },
    run: input => {
      const usage = 'canonry measurement-plan property-evidence <project> --target-key <key>'
      const project = requireProject(input, 'measurement-plan.property-evidence', usage)
      const limitValue = getString(input.values, 'limit')
      const limit = limitValue === undefined ? undefined : Number(limitValue)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        throw usageError('--limit must be an integer from 1 to 100')
      }
      const shape = shapeOption(input)
      return showMeasurementPropertyEvidence(project, {
        ...propertyScope(input, 'measurement-plan.property-evidence', usage),
        ...(shape === undefined ? {} : { shape }),
        cursor: getString(input.values, 'cursor'),
        ...(limit === undefined ? {} : { limit }),
      })
    },
  },
]
