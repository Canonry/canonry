import { addQueries, generateQueries, importQueries, listQueries, removeQueries, replaceQueries } from '../commands/query.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { queryTrackingResultsRequestSchema } from '@ainyc/canonry-contracts'
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
import { runAdvancedMeasurementOperation, showQueryTrackingResults } from '../commands/measurement-plan.js'

const QUERY_RESULTS_USAGE = 'canonry query results <project> [--scope <project|group|market|property>] [--scope-key <key>] [--run <id>] [--format json]'

export const QUERY_CLI_COMMANDS: readonly CliCommandSpec[] = [
  ...(['workspace', 'preview', 'commit'] as const).map(action => ({
    path: ['query', action],
    usage: `canonry query ${action} <project>${action === 'workspace' ? '' : ' <json|->'} [--format json]`,
    run: async (input) => {
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
    options: { scope: stringOption(), 'scope-key': stringOption(), run: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'query.results', QUERY_RESULTS_USAGE)
      const scope = getString(input.values, 'scope')
      const scopeKey = getString(input.values, 'scope-key')
      const runId = getString(input.values, 'run')
      // The endpoint's own selection rules, checked before any request is sent.
      const request = queryTrackingResultsRequestSchema.safeParse({
        ...(scope === undefined ? {} : { scope }),
        ...(scopeKey === undefined ? {} : { scopeKey }),
        ...(runId === undefined ? {} : { runId }),
      })
      if (!request.success) {
        // A failed parse always carries at least one issue.
        const issue = request.error.issues[0]
        const field = issue.path[0]
        // Only the two scope-key rules are worded by the contract. Any other
        // issue is a blank or malformed value, named here by its flag.
        const message = field === 'scope'
          ? '--scope must be one of project, group, market, property'
          : field === 'runId'
            ? '--run needs a value'
            : field === 'scopeKey' && issue.code !== 'custom'
              ? '--scope-key needs a value'
              : issue.message.replace('scopeKey', '--scope-key')
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
      const project = requireProject(input, 'query.list', 'canonry query list <project> [--format json]')
      await listQueries(project, input.format)
    },
  },
  {
    path: ['query', 'import'],
    usage: 'canonry query import <project> <file> [--format json]',
    run: async (input) => {
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
