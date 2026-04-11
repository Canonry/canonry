import { disableSchedule, enableSchedule, removeSchedule, setSchedule, showSchedule } from '../commands/schedule.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, getStringArray, multiStringOption, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const SCHEDULE_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['schedule', 'set'],
    usage: 'canonry schedule set <project> (--preset <preset> | --cron <expr>) [--timezone <tz>] [--provider <name>...] [--format json]',
    options: {
      preset: stringOption(),
      cron: stringOption(),
      timezone: stringOption(),
      provider: multiStringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'schedule.set',
        'canonry schedule set <project> (--preset <preset> | --cron <expr>) [--timezone <tz>] [--provider <name>...] [--format json]',
      )
      if (!getString(input.values, 'preset') && !getString(input.values, 'cron')) {
        throw usageError('Error: --preset or --cron is required', {
          message: 'schedule preset or cron is required',
          details: {
            command: 'schedule.set',
            usage: 'canonry schedule set <project> (--preset <preset> | --cron <expr>) [--timezone <tz>] [--provider <name>...] [--format json]',
            required: ['preset | cron'],
          },
        })
      }
      await setSchedule(project, {
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
    usage: 'canonry schedule show <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'schedule.show', 'canonry schedule show <project> [--format json]')
      await showSchedule(project, input.format)
    },
  },
  {
    path: ['schedule', 'enable'],
    usage: 'canonry schedule enable <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'schedule.enable', 'canonry schedule enable <project> [--format json]')
      await enableSchedule(project, input.format)
    },
  },
  {
    path: ['schedule', 'disable'],
    usage: 'canonry schedule disable <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'schedule.disable', 'canonry schedule disable <project> [--format json]')
      await disableSchedule(project, input.format)
    },
  },
  {
    path: ['schedule', 'remove'],
    usage: 'canonry schedule remove <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'schedule.remove', 'canonry schedule remove <project> [--format json]')
      await removeSchedule(project, input.format)
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
