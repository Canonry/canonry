import { disableSchedule, enableSchedule, removeSchedule, setSchedule, showSchedule } from '../commands/schedule.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, getStringArray, multiStringOption, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const SCHEDULE_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['schedule', 'set'],
    usage: 'canonry schedule set <project> (--preset <preset> | --cron <expr>) [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync] [--source <id>] [--timezone <tz>] [--provider <name>...] [--format json]',
    options: {
      preset: stringOption(),
      cron: stringOption(),
      kind: stringOption(),
      source: stringOption(),
      timezone: stringOption(),
      provider: multiStringOption(),
    },
    run: async (input) => {
      const usage = 'canonry schedule set <project> (--preset <preset> | --cron <expr>) [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync] [--source <id>] [--timezone <tz>] [--provider <name>...] [--format json]'
      const project = requireProject(input, 'schedule.set', usage)
      if (!getString(input.values, 'preset') && !getString(input.values, 'cron')) {
        throw usageError('Error: --preset or --cron is required', {
          message: 'schedule preset or cron is required',
          details: {
            command: 'schedule.set',
            usage,
            required: ['preset | cron'],
          },
        })
      }
      await setSchedule(project, {
        kind: getString(input.values, 'kind'),
        sourceId: getString(input.values, 'source'),
        preset: getString(input.values, 'preset'),
        cron: getString(input.values, 'cron'),
        timezone: getString(input.values, 'timezone'),
        providers: getStringArray(input.values, 'provider'),
        format: input.format,
      })
    },
  },
  {
    path: ['schedule', 'show'],
    usage: 'canonry schedule show <project> [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync] [--format json]',
    options: { kind: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'schedule.show', 'canonry schedule show <project> [--kind ...]')
      await showSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule', 'enable'],
    usage: 'canonry schedule enable <project> [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync] [--format json]',
    options: { kind: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'schedule.enable', 'canonry schedule enable <project> [--kind ...]')
      await enableSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule', 'disable'],
    usage: 'canonry schedule disable <project> [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync] [--format json]',
    options: { kind: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'schedule.disable', 'canonry schedule disable <project> [--kind ...]')
      await disableSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule', 'remove'],
    usage: 'canonry schedule remove <project> [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync] [--format json]',
    options: { kind: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'schedule.remove', 'canonry schedule remove <project> [--kind ...]')
      await removeSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule'],
    usage: 'canonry schedule <set|show|enable|disable|remove> <project>',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'schedule',
        usage: 'canonry schedule <set|show|enable|disable|remove> <project>',
        available: ['set', 'show', 'enable', 'disable', 'remove'],
      })
    },
  },
]
