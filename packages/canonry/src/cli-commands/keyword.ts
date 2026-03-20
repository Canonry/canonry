import { addKeywords, generateKeywords, importKeywords, listKeywords, removeKeywords } from '../commands/keyword.js'
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

export const KEYWORD_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['keyword', 'add'],
    usage: 'canonry keyword add <project> <kw...> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'keyword.add', 'canonry keyword add <project> <kw...> [--format json]')
      const keywords = input.positionals.slice(1)
      if (keywords.length === 0) {
        throw usageError('Error: project name and at least one key phrase required\nUsage: canonry keyword add <project> <kw...> [--format json]', {
          message: 'project name and at least one key phrase required',
          details: {
            command: 'keyword.add',
            usage: 'canonry keyword add <project> <kw...> [--format json]',
          },
        })
      }
      await addKeywords(project, keywords, input.format)
    },
  },
  {
    path: ['keyword', 'remove'],
    usage: 'canonry keyword remove <project> <kw...> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'keyword.remove', 'canonry keyword remove <project> <kw...> [--format json]')
      const keywords = input.positionals.slice(1)
      if (keywords.length === 0) {
        throw usageError('Error: project name and at least one key phrase required\nUsage: canonry keyword remove <project> <kw...> [--format json]', {
          message: 'project name and at least one key phrase required',
          details: {
            command: 'keyword.remove',
            usage: 'canonry keyword remove <project> <kw...> [--format json]',
          },
        })
      }
      await removeKeywords(project, keywords, input.format)
    },
  },
  {
    path: ['keyword', 'delete'],
    usage: 'canonry keyword delete <project> <kw...> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'keyword.delete', 'canonry keyword delete <project> <kw...> [--format json]')
      const keywords = input.positionals.slice(1)
      if (keywords.length === 0) {
        throw usageError('Error: project name and at least one key phrase required\nUsage: canonry keyword delete <project> <kw...> [--format json]', {
          message: 'project name and at least one key phrase required',
          details: {
            command: 'keyword.delete',
            usage: 'canonry keyword delete <project> <kw...> [--format json]',
          },
        })
      }
      await removeKeywords(project, keywords, input.format)
    },
  },
  {
    path: ['keyword', 'list'],
    usage: 'canonry keyword list <project>',
    run: async (input) => {
      const project = requireProject(input, 'keyword.list', 'canonry keyword list <project>')
      await listKeywords(project, input.format)
    },
  },
  {
    path: ['keyword', 'import'],
    usage: 'canonry keyword import <project> <file> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'keyword.import', 'canonry keyword import <project> <file> [--format json]')
      const filePath = requirePositional(input, 1, {
        command: 'keyword.import',
        usage: 'canonry keyword import <project> <file> [--format json]',
        message: 'project name and file path required',
      })
      await importKeywords(project, filePath, input.format)
    },
  },
  {
    path: ['keyword', 'generate'],
    usage: 'canonry keyword generate <project> --provider <name> [--count <n>] [--save] [--format json]',
    options: {
      provider: stringOption(),
      count: stringOption(),
      save: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'keyword.generate',
        'canonry keyword generate <project> --provider <name> [--count <n>] [--save] [--format json]',
      )
      const provider = requireStringOption(input, 'provider', {
        command: 'keyword.generate',
        usage: 'canonry keyword generate <project> --provider <name> [--count <n>] [--save] [--format json]',
        message: '--provider is required (e.g. gemini, openai, claude, perplexity, local)',
      })
      await generateKeywords(project, provider, {
        count: parseIntegerOption(input, 'count', {
          command: 'keyword.generate',
          usage: 'canonry keyword generate <project> --provider <name> [--count <n>] [--save] [--format json]',
          message: '--count must be an integer',
        }),
        save: getBoolean(input.values, 'save'),
        format: input.format,
      })
    },
  },
  {
    path: ['keyword'],
    usage: 'canonry keyword <add|remove|delete|list|import|generate> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'keyword',
        usage: 'canonry keyword <add|remove|delete|list|import|generate> <project> [args]',
        available: ['add', 'remove', 'delete', 'list', 'import', 'generate'],
      })
    },
  },
]
