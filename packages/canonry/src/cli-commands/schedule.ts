import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, getStringArray, multiStringOption, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

export const SCHEDULE_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['schedule', 'list'],
    usage: 'canonry schedule list <project> [--format json|jsonl]',
    run: async input => {
      const { listSchedules } = await import('../commands/schedule.js')
      await listSchedules(requireProject(input, 'schedule.list', 'canonry schedule list <project>'), input.format)
    },
  },
  {
    path: ['schedule', 'set'],
    usage: 'canonry schedule set <project> (--preset <preset> | --cron <expr> | --every-days <n> --start-date <YYYY-MM-DD> --at <HH:mm>) [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync|site-audit|ads-sync|doctor|seo-sync] [--source <id>] [--timezone <tz>] [--provider <name>...] [--check-dead-links] [--include-geo] [--no-agent-skills] [--default-checks] [--format json]',
    options: {
      preset: stringOption(),
      cron: stringOption(),
      'every-days': stringOption(),
      'start-date': stringOption(),
      at: stringOption(),
      kind: stringOption(),
      source: stringOption(),
      timezone: stringOption(),
      provider: multiStringOption(),
      // Scan checks, for --kind site-audit only. Any of the first three sets the
      // whole list of checks; --default-checks resets it. Without them the
      // schedule keeps the checks it has.
      'check-dead-links': { type: 'boolean', default: false },
      'include-geo': { type: 'boolean', default: false },
      'no-agent-skills': { type: 'boolean', default: false },
      'default-checks': { type: 'boolean', default: false },
    },
    run: async (input) => {
      const { setSchedule } = await import('../commands/schedule.js')
      const usage = 'canonry schedule set <project> (--preset <preset> | --cron <expr> | --every-days <n> --start-date <YYYY-MM-DD> --at <HH:mm>) [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync|site-audit|ads-sync|doctor|seo-sync] [--source <id>] [--timezone <tz>] [--provider <name>...] [--check-dead-links] [--include-geo] [--no-agent-skills] [--default-checks] [--format json]'
      const project = requireProject(input, 'schedule.set', usage)
      const preset = getString(input.values, 'preset')
      const cron = getString(input.values, 'cron')
      const everyDays = getString(input.values, 'every-days')
      const startDate = getString(input.values, 'start-date')
      const at = getString(input.values, 'at')
      const recurrenceFlags = [everyDays, startDate, at].filter(Boolean)
      const kind = getString(input.values, 'kind')
      const checkDeadLinks = getBoolean(input.values, 'check-dead-links')
      const includeGeo = getBoolean(input.values, 'include-geo')
      const noAgentSkills = getBoolean(input.values, 'no-agent-skills')
      const defaultChecks = getBoolean(input.values, 'default-checks')
      const setsChecks = checkDeadLinks || includeGeo || noAgentSkills
      if ((setsChecks || defaultChecks) && kind !== 'site-audit') {
        throw usageError('Error: scan check flags need --kind site-audit', {
          message: 'scan check flags are only valid for site-audit schedules',
          details: { command: 'schedule.set', usage, required: ['--kind site-audit'] },
        })
      }
      if (setsChecks && defaultChecks) {
        throw usageError('Error: --default-checks cannot be combined with other check flags', {
          message: 'default-checks resets the checks; it cannot be combined with check flags',
          details: { command: 'schedule.set', usage },
        })
      }
      if (recurrenceFlags.length > 0 && recurrenceFlags.length < 3) {
        throw usageError('Error: --every-days, --start-date, and --at must be used together', {
          message: 'schedule recurrence requires every-days, start-date, and at',
          details: { command: 'schedule.set', usage, required: ['every-days + start-date + at'] },
        })
      }
      const timingCount = Number(Boolean(preset)) + Number(Boolean(cron)) + Number(recurrenceFlags.length === 3)
      // Changing only the checks keeps the schedule's current timing.
      const checksOnly = timingCount === 0 && (setsChecks || defaultChecks)
      if (timingCount !== 1 && !checksOnly) {
        throw usageError('Error: exactly one schedule timing is required', {
          message: 'exactly one of schedule preset, cron, or recurrence is required',
          details: { command: 'schedule.set', usage, required: ['preset | cron | recurrence'] },
        })
      }
      await setSchedule(project, {
        kind,
        sourceId: getString(input.values, 'source'),
        siteAudit: defaultChecks ? null : setsChecks ? { checkDeadLinks, includeGeo, includeAgentSkills: !noAgentSkills } : undefined,
        preset,
        cron,
        everyDays,
        startDate,
        at,
        timezone: getString(input.values, 'timezone'),
        providers: getStringArray(input.values, 'provider'),
        format: input.format,
      })
    },
  },
  {
    path: ['schedule', 'show'],
    usage: 'canonry schedule show <project> [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync|site-audit|ads-sync|doctor|seo-sync] [--format json]',
    options: { kind: stringOption() },
    run: async (input) => {
      const { showSchedule } = await import('../commands/schedule.js')
      const project = requireProject(input, 'schedule.show', 'canonry schedule show <project> [--kind ...]')
      await showSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule', 'enable'],
    usage: 'canonry schedule enable <project> [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync|site-audit|ads-sync|doctor|seo-sync] [--format json]',
    options: { kind: stringOption() },
    run: async (input) => {
      const { enableSchedule } = await import('../commands/schedule.js')
      const project = requireProject(input, 'schedule.enable', 'canonry schedule enable <project> [--kind ...]')
      await enableSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule', 'disable'],
    usage: 'canonry schedule disable <project> [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync|site-audit|ads-sync|doctor|seo-sync] [--format json]',
    options: { kind: stringOption() },
    run: async (input) => {
      const { disableSchedule } = await import('../commands/schedule.js')
      const project = requireProject(input, 'schedule.disable', 'canonry schedule disable <project> [--kind ...]')
      await disableSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule', 'remove'],
    usage: 'canonry schedule remove <project> [--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync|site-audit|ads-sync|doctor|seo-sync] [--format json]',
    options: { kind: stringOption() },
    run: async (input) => {
      const { removeSchedule } = await import('../commands/schedule.js')
      const project = requireProject(input, 'schedule.remove', 'canonry schedule remove <project> [--kind ...]')
      await removeSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule'],
    usage: 'canonry schedule <list|set|show|enable|disable|remove> <project>',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'schedule',
        usage: 'canonry schedule <list|set|show|enable|disable|remove> <project>',
        available: ['list', 'set', 'show', 'enable', 'disable', 'remove'],
      })
    },
  },
]
