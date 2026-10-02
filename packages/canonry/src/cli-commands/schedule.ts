import { SchedulableRunKinds, type SiteAuditScheduleOptions } from '@ainyc/canonry-contracts'
import { disableSchedule, enableSchedule, listSchedules, removeSchedule, setSchedule, showSchedule } from '../commands/schedule.js'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, getStringArray, multiStringOption, parseIntegerOption, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const KIND_USAGE = '[--kind answer-visibility|traffic-sync|gbp-sync|data-refresh|backlinks-sync|site-audit|ads-sync|doctor]'
const SET_USAGE = `canonry schedule set <project> (--preset <preset> | --cron <expr> | --every-days <n> --start-date <YYYY-MM-DD> --at <HH:mm>) ${KIND_USAGE} [--source <id>] [--timezone <tz>] [--provider <name>...] [--max-pages <n>] [--max-edges <n>] [--max-depth <n>] [--sitemap-url <url>] [--check-dead-links|--no-check-dead-links] [--clear-site-audit-options] [--format json]`

/** Crawl flags `schedule set` accepts for kind site-audit, in the order errors name them. */
const SITE_AUDIT_FLAGS = ['max-pages', 'max-edges', 'max-depth', 'sitemap-url', 'check-dead-links', 'no-check-dead-links', 'clear-site-audit-options'] as const

/**
 * Read the site-audit crawl flags. Returns `undefined` when none were given, so
 * the stored crawl options are left as they are; `clear` resets them, and the
 * scheduled audit then scans the full site. Limits are the server's.
 */
function parseSiteAuditFlags(input: CliCommandInput, kind: string | undefined):
  | { clear: true }
  | { clear: false; options: SiteAuditScheduleOptions }
  | undefined {
  const given = SITE_AUDIT_FLAGS.filter(flag => input.values[flag] !== undefined && input.values[flag] !== false)
  if (given.length === 0) return undefined
  const failure = (message: string, details: Record<string, unknown> = {}) =>
    usageError(`Error: ${message}\nUsage: ${SET_USAGE}`, {
      message,
      details: { command: 'schedule.set', usage: SET_USAGE, ...details },
    })
  if (kind !== SchedulableRunKinds['site-audit']) {
    throw failure(`--${given[0]} is only valid with --kind site-audit`, {
      option: given[0],
      kind: kind ?? SchedulableRunKinds['answer-visibility'],
    })
  }
  if (getBoolean(input.values, 'clear-site-audit-options')) {
    if (given.length > 1) throw failure('--clear-site-audit-options cannot be combined with other crawl options')
    return { clear: true }
  }
  if (getBoolean(input.values, 'check-dead-links') && getBoolean(input.values, 'no-check-dead-links')) {
    throw failure('--check-dead-links and --no-check-dead-links cannot be combined')
  }
  const integer = (key: 'max-pages' | 'max-edges' | 'max-depth') =>
    parseIntegerOption(input, key, { command: 'schedule.set', usage: SET_USAGE, message: `--${key} must be an integer` })
  const options: SiteAuditScheduleOptions = {}
  const maxPages = integer('max-pages')
  const maxEdges = integer('max-edges')
  const maxDepth = integer('max-depth')
  const sitemapUrl = getString(input.values, 'sitemap-url')
  if (maxPages !== undefined) options.maxPages = maxPages
  if (maxEdges !== undefined) options.maxEdges = maxEdges
  if (maxDepth !== undefined) options.maxDepth = maxDepth
  if (sitemapUrl !== undefined) options.sitemapUrl = sitemapUrl
  if (getBoolean(input.values, 'check-dead-links')) options.checkDeadLinks = true
  if (getBoolean(input.values, 'no-check-dead-links')) options.checkDeadLinks = false
  return { clear: false, options }
}

export const SCHEDULE_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['schedule', 'list'],
    usage: 'canonry schedule list <project> [--format json|jsonl]',
    run: async input => {
      await listSchedules(requireProject(input, 'schedule.list', 'canonry schedule list <project>'), input.format)
    },
  },
  {
    path: ['schedule', 'set'],
    usage: SET_USAGE,
    help: 'Create or update a schedule. For --kind site-audit, the crawl flags set the options the scheduled audit runs with (limits as for `technical-aeo run`); flags you omit keep their stored values, and with no stored options a scheduled audit scans the full site up to 50,000 pages. --clear-site-audit-options returns to that full-site default.',
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
      'max-pages': stringOption(),
      'max-edges': stringOption(),
      'max-depth': stringOption(),
      'sitemap-url': stringOption(),
      'check-dead-links': { type: 'boolean' },
      'no-check-dead-links': { type: 'boolean' },
      'clear-site-audit-options': { type: 'boolean' },
    },
    run: async (input) => {
      const usage = SET_USAGE
      const project = requireProject(input, 'schedule.set', usage)
      const preset = getString(input.values, 'preset')
      const cron = getString(input.values, 'cron')
      const everyDays = getString(input.values, 'every-days')
      const startDate = getString(input.values, 'start-date')
      const at = getString(input.values, 'at')
      const recurrenceFlags = [everyDays, startDate, at].filter(Boolean)
      if (recurrenceFlags.length > 0 && recurrenceFlags.length < 3) {
        throw usageError('Error: --every-days, --start-date, and --at must be used together', {
          message: 'schedule recurrence requires every-days, start-date, and at',
          details: { command: 'schedule.set', usage, required: ['every-days + start-date + at'] },
        })
      }
      const timingCount = Number(Boolean(preset)) + Number(Boolean(cron)) + Number(recurrenceFlags.length === 3)
      if (timingCount !== 1) {
        throw usageError('Error: exactly one schedule timing is required', {
          message: 'exactly one of schedule preset, cron, or recurrence is required',
          details: { command: 'schedule.set', usage, required: ['preset | cron | recurrence'] },
        })
      }
      const kind = getString(input.values, 'kind')
      const siteAudit = parseSiteAuditFlags(input, kind)
      await setSchedule(project, {
        kind,
        sourceId: getString(input.values, 'source'),
        preset,
        cron,
        everyDays,
        startDate,
        at,
        timezone: getString(input.values, 'timezone'),
        providers: getStringArray(input.values, 'provider'),
        ...(siteAudit?.clear ? { clearSiteAuditOptions: true } : {}),
        ...(siteAudit && !siteAudit.clear ? { siteAuditOptions: siteAudit.options } : {}),
        format: input.format,
      })
    },
  },
  {
    path: ['schedule', 'show'],
    usage: `canonry schedule show <project> ${KIND_USAGE} [--format json]`,
    options: { kind: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'schedule.show', 'canonry schedule show <project> [--kind ...]')
      await showSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule', 'enable'],
    usage: `canonry schedule enable <project> ${KIND_USAGE} [--format json]`,
    options: { kind: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'schedule.enable', 'canonry schedule enable <project> [--kind ...]')
      await enableSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule', 'disable'],
    usage: `canonry schedule disable <project> ${KIND_USAGE} [--format json]`,
    options: { kind: stringOption() },
    run: async (input) => {
      const project = requireProject(input, 'schedule.disable', 'canonry schedule disable <project> [--kind ...]')
      await disableSchedule(project, input.format, getString(input.values, 'kind'))
    },
  },
  {
    path: ['schedule', 'remove'],
    usage: `canonry schedule remove <project> ${KIND_USAGE} [--format json]`,
    options: { kind: stringOption() },
    run: async (input) => {
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
