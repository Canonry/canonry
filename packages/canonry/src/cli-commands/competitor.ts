import { competitorLandscapeQuerySchema } from '@ainyc/canonry-contracts'
import { addCompetitors, competitorAliases, detectCompetitorAutoAliases, listCompetitors, removeCompetitors, showCompetitorLandscape } from '../commands/competitor.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, getStringArray, multiStringOption, requirePositional, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const ADD_USAGE = 'canonry competitor add <project> <domain...> [--alias <name>]... [--format json]'
const ALIASES_USAGE = 'canonry competitor aliases <project> <domain> [--set <name>]... [--add <name>]... [--remove <name>]... [--clear] [--block <name>]... [--unblock <name>]... [--format json]'
const DETECT_USAGE = 'canonry competitor aliases detect <project> [--apply] [--format json|jsonl]'

const LANDSCAPE_USAGE = 'canonry competitor landscape <project> [--window 7d|30d|90d|all] [--group-key <key>|--scope all-markets] [--by-model] [--provider <provider> [--model <id>]] [--query-class all|branded|non-brand] [--answers all|not-mentioned] [--location <label>] [--run-id <id>] [--format json|jsonl]'

function parseLandscapeScope(value: string | undefined): 'all-markets' | undefined {
  if (value === undefined || value === '') return undefined
  if (value !== 'all-markets') throw usageError(`--scope must be "all-markets" (got "${value}")`, {
    message: '--scope must be "all-markets"',
    details: { command: 'competitor.landscape', usage: LANDSCAPE_USAGE },
  })
  return value
}

export const COMPETITOR_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['competitor', 'add'],
    usage: ADD_USAGE,
    options: {
      alias: multiStringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'competitor.add', ADD_USAGE)
      const domains = input.positionals.slice(1)
      if (domains.length === 0) {
        throw usageError(`Error: project name and at least one domain required\nUsage: ${ADD_USAGE}`, {
          message: 'project name and at least one domain required',
          details: {
            command: 'competitor.add',
            usage: ADD_USAGE,
          },
        })
      }
      const aliases = getStringArray(input.values, 'alias') ?? []
      if (aliases.length > 0 && domains.length !== 1) {
        throw usageError(`Error: --alias names one competitor, so pass exactly one domain\nUsage: ${ADD_USAGE}`, {
          message: '--alias names one competitor, so pass exactly one domain',
          details: { command: 'competitor.add', usage: ADD_USAGE },
        })
      }
      await addCompetitors(project, domains, input.format, aliases)
    },
  },
  {
    // Longest path wins in dispatch, so `detect` is reserved as the first
    // positional: a project literally named "detect" reads its aliases with
    // `competitor list detect`.
    path: ['competitor', 'aliases', 'detect'],
    usage: DETECT_USAGE,
    options: {
      apply: { type: 'boolean' },
    },
    run: async (input) => {
      const project = requireProject(input, 'competitor.aliases.detect', DETECT_USAGE)
      await detectCompetitorAutoAliases(project, { apply: getBoolean(input.values, 'apply'), format: input.format })
    },
  },
  {
    path: ['competitor', 'aliases'],
    usage: ALIASES_USAGE,
    options: {
      set: multiStringOption(),
      add: multiStringOption(),
      remove: multiStringOption(),
      clear: { type: 'boolean' },
      block: multiStringOption(),
      unblock: multiStringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'competitor.aliases', ALIASES_USAGE)
      const domain = requirePositional(input, 1, {
        command: 'competitor.aliases',
        usage: ALIASES_USAGE,
        message: 'competitor domain is required',
      })
      const set = getStringArray(input.values, 'set')
      const add = getStringArray(input.values, 'add')
      const remove = getStringArray(input.values, 'remove')
      const clear = getBoolean(input.values, 'clear')
      const block = getStringArray(input.values, 'block')
      const unblock = getStringArray(input.values, 'unblock')
      if ((block !== undefined || unblock !== undefined)
        && (block !== undefined && unblock !== undefined || set !== undefined || clear || add !== undefined || remove !== undefined)) {
        throw usageError(`Error: --block and --unblock change answer-derived auto-detection only, so they cannot be combined with each other or with curated edits (--set, --add, --remove, --clear)\nUsage: ${ALIASES_USAGE}`, {
          message: '--block and --unblock cannot be combined with each other or with --set/--add/--remove/--clear',
          details: { command: 'competitor.aliases', usage: ALIASES_USAGE },
        })
      }
      const exclusive = [set !== undefined, clear].filter(Boolean).length
      if (exclusive > 1 || (exclusive === 1 && (add !== undefined || remove !== undefined))) {
        throw usageError(`Error: --set and --clear replace the whole list, so they cannot be combined with each other or with --add/--remove\nUsage: ${ALIASES_USAGE}`, {
          message: '--set and --clear cannot be combined with each other or with --add/--remove',
          details: { command: 'competitor.aliases', usage: ALIASES_USAGE },
        })
      }
      await competitorAliases(project, domain, { set, add, remove, clear, block, unblock, format: input.format })
    },
  },
  {
    path: ['competitor', 'remove'],
    usage: 'canonry competitor remove <project> <domain...> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'competitor.remove', 'canonry competitor remove <project> <domain...> [--format json]')
      const domains = input.positionals.slice(1)
      if (domains.length === 0) {
        throw usageError('Error: project name and at least one domain required\nUsage: canonry competitor remove <project> <domain...> [--format json]', {
          message: 'project name and at least one domain required',
          details: {
            command: 'competitor.remove',
            usage: 'canonry competitor remove <project> <domain...> [--format json]',
          },
        })
      }
      await removeCompetitors(project, domains, input.format)
    },
  },
  {
    path: ['competitor', 'delete'],
    usage: 'canonry competitor delete <project> <domain...> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'competitor.delete', 'canonry competitor delete <project> <domain...> [--format json]')
      const domains = input.positionals.slice(1)
      if (domains.length === 0) {
        throw usageError('Error: project name and at least one domain required\nUsage: canonry competitor delete <project> <domain...> [--format json]', {
          message: 'project name and at least one domain required',
          details: {
            command: 'competitor.delete',
            usage: 'canonry competitor delete <project> <domain...> [--format json]',
          },
        })
      }
      await removeCompetitors(project, domains, input.format)
    },
  },
  {
    path: ['competitor', 'list'],
    usage: 'canonry competitor list <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'competitor.list', 'canonry competitor list <project>')
      await listCompetitors(project, input.format)
    },
  },
  {
    path: ['competitor', 'landscape'],
    usage: LANDSCAPE_USAGE,
    options: {
      window: stringOption(),
      'group-key': stringOption(),
      scope: stringOption(),
      provider: stringOption(),
      'by-model': { type: 'boolean' },
      model: stringOption(),
      'query-class': stringOption(),
      location: stringOption(),
      'run-id': stringOption(),
      answers: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'competitor.landscape', LANDSCAPE_USAGE)
      const scope = parseLandscapeScope(getString(input.values, 'scope'))
      const groupKey = getString(input.values, 'group-key')
      const provider = getString(input.values, 'provider')
      const model = getString(input.values, 'model')
      if (model !== undefined && !provider?.trim()) {
        throw usageError('--model requires --provider', {
          message: '--model requires --provider',
          details: { command: 'competitor.landscape', usage: LANDSCAPE_USAGE },
        })
      }
      if (scope === 'all-markets' && groupKey) {
        throw usageError('--group-key cannot be combined with --scope all-markets', {
          message: '--group-key cannot be combined with --scope all-markets',
          details: { command: 'competitor.landscape', usage: LANDSCAPE_USAGE },
        })
      }
      const parsedAnswers = competitorLandscapeQuerySchema.safeParse({ answers: getString(input.values, 'answers') })
      if (!parsedAnswers.success) throw usageError('--answers must be all or not-mentioned')
      await showCompetitorLandscape(project, {
        answers: parsedAnswers.data.answers,
        window: getString(input.values, 'window') as '7d' | '30d' | '90d' | 'all' | undefined,
        groupKey,
        scope,
        provider,
        ...(getBoolean(input.values, 'by-model') ? { groupBy: 'model' } : {}),
        ...(model !== undefined ? { model } : {}),
        queryClass: getString(input.values, 'query-class') as 'all' | 'branded' | 'non-brand' | undefined,
        location: getString(input.values, 'location'),
        runId: getString(input.values, 'run-id'),
        format: input.format,
      })
    },
  },
  {
    path: ['competitor'],
    usage: 'canonry competitor <add|aliases|remove|delete|list|landscape> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'competitor',
        usage: 'canonry competitor <add|aliases|remove|delete|list|landscape> <project> [args]',
        available: ['add', 'aliases', 'remove', 'delete', 'list', 'landscape'],
      })
    },
  },
]
