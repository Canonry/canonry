import type { CliCommandSpec } from '../cli-dispatch.js'
import { queryTrackingResultsRequestSchema } from '@canonry/canonry-contracts'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requirePositional,
  requireProject,
  requireStringOption,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const QUERY_RESULTS_USAGE = 'canonry query results <project> [--scope <project|group|market|property>] [--scope-key <key>] [--run <id>] [--query <id>]'
  + ' [--signal <mentioned|cited>] [--sort <losing|winning>] [--group <market|group>] [--compare previous]'
  + ' [--engine <name>] [--result <mentioned|not-mentioned|cited|not-cited>] [--change <won|lost>] [--format json]'

/** Each field of the read by the flag that sets it, so an error names the flag. */
const QUERY_RESULTS_FLAGS = {
  scope: 'scope', scopeKey: 'scope-key', runId: 'run', queryId: 'query', signal: 'signal', sort: 'sort',
  group: 'group', compare: 'compare', engine: 'engine', result: 'result', change: 'change',
} as const
type QueryResultsField = keyof typeof QUERY_RESULTS_FLAGS

export const QUERY_CLI_COMMANDS: readonly CliCommandSpec[] = [
  ...(['workspace', 'preview', 'commit'] as const).map(action => ({
    path: ['query', action],
    usage: `canonry query ${action} <project>${action === 'workspace' ? '' : ' <json|->'} [--format json]`,
    run: async (input) => {
      const { runAdvancedMeasurementOperation } = await import('../commands/measurement-plan.js')
      const usage = `canonry query ${action} <project>${action === 'workspace' ? '' : ' <json|->'} [--format json]`
      const project = requireProject(input, `query.${action}`, usage)
      const source = action === 'workspace' ? undefined : requirePositional(input, 1, {
        command: `query.${action}`, usage, message: 'A preview or commit JSON file is required',
      })
      await runAdvancedMeasurementOperation(project, `query-${action}`, source, input.format)
    },
  } satisfies CliCommandSpec)),
  {
    path: ['query', 'results'],
    usage: QUERY_RESULTS_USAGE,
    options: Object.fromEntries(Object.values(QUERY_RESULTS_FLAGS).map(flag => [flag, stringOption()])),
    run: async (input) => {
      const { showQueryTrackingResults } = await import('../commands/measurement-plan.js')
      const project = requireProject(input, 'query.results', QUERY_RESULTS_USAGE)
      // The endpoint's own selection rules, checked before any request is sent.
      const request = queryTrackingResultsRequestSchema.safeParse(Object.fromEntries(
        (Object.entries(QUERY_RESULTS_FLAGS) as Array<[QueryResultsField, string]>).flatMap(([field, flag]) => {
          const value = getString(input.values, flag)
          return value === undefined ? [] : [[field, value]]
        }),
      ))
      if (!request.success) {
        // A failed parse always carries at least one issue, on one of the fields above.
        const issue = request.error.issues[0]
        const flag = `--${QUERY_RESULTS_FLAGS[issue.path[0] as QueryResultsField]}`
        // The contract words its own rules by field name; here they name the flag.
        // Any other issue is a blank value, as an unset shell variable leaves.
        const message = issue.code === 'invalid_value'
          ? issue.values.length === 1
            ? `${flag} must be ${String(issue.values[0])}`
            : `${flag} must be one of ${issue.values.map(String).join(', ')}`
          : issue.code === 'custom'
            ? issue.message.replace(/^\w+/, flag).replace('queryId', '--query').replace('compare=previous', '--compare previous')
              .replace('engine, result or change', '--engine, --result or --change')
            : `${flag} needs a value`
        throw usageError(`Error: ${message}\nUsage: ${QUERY_RESULTS_USAGE}`, {
          message,
          details: { command: 'query.results', usage: QUERY_RESULTS_USAGE },
        })
      }
      await showQueryTrackingResults(project, { ...request.data, format: input.format })
    },
  },
  {
    path: ['query', 'add'],
    usage: 'canonry query add <project> <query...> [--format json]',
    run: async (input) => {
      const { addQueries } = await import('../commands/query.js')
      const project = requireProject(input, 'query.add', 'canonry query add <project> <query...> [--format json]')
      const queries = input.positionals.slice(1)
      if (queries.length === 0) {
        throw usageError('Error: project name and at least one query required\nUsage: canonry query add <project> <query...> [--format json]', {
          message: 'project name and at least one query required',
          details: {
            command: 'query.add',
            usage: 'canonry query add <project> <query...> [--format json]',
          },
        })
      }
      await addQueries(project, queries, input.format)
    },
  },
  {
    path: ['query', 'replace'],
    usage: 'canonry query replace <project> <query...> [--dry-run] [--format json]',
    supportsDryRun: true,
    run: async (input) => {
      const { replaceQueries } = await import('../commands/query.js')
      const project = requireProject(input, 'query.replace', 'canonry query replace <project> <query...> [--dry-run] [--format json]')
      const queries = input.positionals.slice(1)
      if (queries.length === 0) {
        throw usageError('Error: project name and at least one query required\nUsage: canonry query replace <project> <query...> [--dry-run] [--format json]', {
          message: 'project name and at least one query required',
          details: {
            command: 'query.replace',
            usage: 'canonry query replace <project> <query...> [--dry-run] [--format json]',
          },
        })
      }
      await replaceQueries(project, queries, { dryRun: input.dryRun, format: input.format })
    },
  },
  {
    path: ['query', 'remove'],
    usage: 'canonry query remove <project> <query...> [--format json]',
    run: async (input) => {
      const { removeQueries } = await import('../commands/query.js')
      const project = requireProject(input, 'query.remove', 'canonry query remove <project> <query...> [--format json]')
      const queries = input.positionals.slice(1)
      if (queries.length === 0) {
        throw usageError('Error: project name and at least one query required\nUsage: canonry query remove <project> <query...> [--format json]', {
          message: 'project name and at least one query required',
          details: {
            command: 'query.remove',
            usage: 'canonry query remove <project> <query...> [--format json]',
          },
        })
      }
      await removeQueries(project, queries, input.format)
    },
  },
  {
    path: ['query', 'delete'],
    usage: 'canonry query delete <project> <query...> [--format json]',
    run: async (input) => {
      const { removeQueries } = await import('../commands/query.js')
      const project = requireProject(input, 'query.delete', 'canonry query delete <project> <query...> [--format json]')
      const queries = input.positionals.slice(1)
      if (queries.length === 0) {
        throw usageError('Error: project name and at least one query required\nUsage: canonry query delete <project> <query...> [--format json]', {
          message: 'project name and at least one query required',
          details: {
            command: 'query.delete',
            usage: 'canonry query delete <project> <query...> [--format json]',
          },
        })
      }
      await removeQueries(project, queries, input.format)
    },
  },
  {
    path: ['query', 'list'],
    usage: 'canonry query list <project> [--format json]',
    run: async (input) => {
      const { listQueries } = await import('../commands/query.js')
      const project = requireProject(input, 'query.list', 'canonry query list <project> [--format json]')
      await listQueries(project, input.format)
    },
  },
  {
    path: ['query', 'import'],
    usage: 'canonry query import <project> <file> [--format json]',
    run: async (input) => {
      const { importQueries } = await import('../commands/query.js')
      const project = requireProject(input, 'query.import', 'canonry query import <project> <file> [--format json]')
      const filePath = requirePositional(input, 1, {
        command: 'query.import',
        usage: 'canonry query import <project> <file> [--format json]',
        message: 'project name and file path required',
      })
      await importQueries(project, filePath, input.format)
    },
  },
  {
    path: ['query', 'generate'],
    usage: 'canonry query generate <project> --provider <name> [--count <n>] [--save] [--format json]',
    options: {
      provider: stringOption(),
      count: stringOption(),
      save: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const { generateQueries } = await import('../commands/query.js')
      const project = requireProject(
        input,
        'query.generate',
        'canonry query generate <project> --provider <name> [--count <n>] [--save] [--format json]',
      )
      const provider = requireStringOption(input, 'provider', {
        command: 'query.generate',
        usage: 'canonry query generate <project> --provider <name> [--count <n>] [--save] [--format json]',
        message: '--provider is required (e.g. gemini, openai, claude, perplexity, muse, local)',
      })
      await generateQueries(project, provider, {
        count: parseIntegerOption(input, 'count', {
          command: 'query.generate',
          usage: 'canonry query generate <project> --provider <name> [--count <n>] [--save] [--format json]',
          message: '--count must be an integer',
        }),
        save: getBoolean(input.values, 'save'),
        format: input.format,
      })
    },
  },
  {
    path: ['query'],
    usage: 'canonry query <add|replace|remove|delete|list|import|generate|workspace|preview|commit|results> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'query',
        usage: 'canonry query <add|replace|remove|delete|list|import|generate|workspace|preview|commit|results> <project> [args]',
        available: ['add', 'replace', 'remove', 'delete', 'list', 'import', 'generate', 'workspace', 'preview', 'commit', 'results'],
      })
    },
  },
]
