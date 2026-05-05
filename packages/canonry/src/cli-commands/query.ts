import { addQueries, generateQueries, importQueries, listQueries, removeQueries, replaceQueries } from '../commands/query.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  parseIntegerOption,
  requirePositional,
  requireProject,
  requireStringOption,
  stringOption,
  unknownSubcommand,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const QUERY_CLI_COMMANDS: readonly CliCommandSpec[] = [
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
    usage: 'canonry query replace <project> <query...> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'query.replace', 'canonry query replace <project> <query...> [--format json]')
      const queries = input.positionals.slice(1)
      if (queries.length === 0) {
        throw usageError('Error: project name and at least one query required\nUsage: canonry query replace <project> <query...> [--format json]', {
          message: 'project name and at least one query required',
          details: {
            command: 'query.replace',
            usage: 'canonry query replace <project> <query...> [--format json]',
          },
        })
      }
      await replaceQueries(project, queries, input.format)
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
        message: '--provider is required (e.g. gemini, openai, claude, perplexity, local)',
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
    usage: 'canonry query <add|replace|remove|delete|list|import|generate> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'query',
        usage: 'canonry query <add|replace|remove|delete|list|import|generate> <project> [args]',
        available: ['add', 'replace', 'remove', 'delete', 'list', 'import', 'generate'],
      })
    },
  },
]
