import { cancelRun, listRuns, showRun, triggerRun, triggerRunAll } from '../commands/run.js'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, getStringArray, multiStringOption, parseIntegerOption, requirePositional, requireProject, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const RUN_TRIGGER_USAGE = 'canonry run trigger <project> [--group <key>]... [--target <key>]... [--provider <name>] [--query <q>...] [--location <label>] [--all-locations] [--no-location] [--probe] [--wait] [--format json]'
const RUN_USAGE = 'canonry run <project|--all> [--group <key>]... [--target <key>]... [--provider <name>] [--query <q>...] [--location <label>] [--all-locations] [--no-location] [--probe] [--wait] [--format json]'
const RUNS_USAGE = 'canonry runs <project> [--limit <n>] [--kind <kind>] [--status <status>] [--format json]'

const RUN_TRIGGER_OPTIONS = {
  provider: stringOption(),
  query: multiStringOption(),
  // Measure one slice of the project's published measurement plan. A group
  // stands for its member targets; repeat either flag to widen the slice.
  group: multiStringOption(),
  target: multiStringOption(),
  wait: { type: 'boolean', default: false },
  all: { type: 'boolean', default: false },
  location: stringOption(),
  'all-locations': { type: 'boolean', default: false },
  'no-location': { type: 'boolean', default: false },
  // Probe runs are operator/agent test runs — they write a snapshot
  // for inspection but are excluded from dashboard / analytics /
  // intelligence / notifications. Use when you want to verify a
  // provider works without polluting the project's metrics.
  probe: { type: 'boolean', default: false },
} as const

async function triggerRunCommand(input: CliCommandInput, command: string): Promise<void> {
  const groups = getStringArray(input.values, 'group') ?? []
  const targets = getStringArray(input.values, 'target') ?? []
  const queries = getStringArray(input.values, 'query') ?? []
  const usage = command === 'run' ? RUN_USAGE : RUN_TRIGGER_USAGE

  if (getBoolean(input.values, 'all')) {
    if (input.positionals.length > 0) {
      throw usageError('Error: --all cannot be combined with a project name', {
        message: '--all cannot be combined with a project name',
        details: {
          command,
          usage: 'canonry run --all [--provider <name>] [--wait] [--format json]',
        },
      })
    }
    if (queries.length) {
      throw usageError('Error: --query cannot be combined with --all (query scope is project-specific)', {
        message: '--query cannot be combined with --all (query scope is project-specific)',
        details: {
          command,
          usage: 'canonry run <project> --query <q>... [--provider <name>] [--wait] [--format json]',
        },
      })
    }
    if (groups.length || targets.length) {
      throw usageError('Error: --group and --target cannot be combined with --all (a plan slice belongs to one project)', {
        message: '--group and --target cannot be combined with --all (a plan slice belongs to one project)',
        details: { command, usage },
      })
    }
    await triggerRunAll({
      provider: getString(input.values, 'provider'),
      wait: getBoolean(input.values, 'wait'),
      allLocations: getBoolean(input.values, 'all-locations'),
      noLocation: getBoolean(input.values, 'no-location'),
      format: input.format,
    })
    return
  }

  // Two different ways to measure a subset. A plan-scoped run executes the
  // plan's own nodes and never looks at a query list, so accepting both would
  // silently drop one of them.
  if (queries.length && (groups.length || targets.length)) {
    throw usageError('Error: --query cannot be combined with --group or --target (pick questions, or pick a slice of the plan)', {
      message: '--query cannot be combined with --group or --target (pick questions, or pick a slice of the plan)',
      details: { command, usage },
    })
  }

  const project = requireProject(
    input,
    command,
    usage,
    command === 'run' ? 'project name is required (or use --all)' : 'project name is required',
  )

  await triggerRun(project, {
    provider: getString(input.values, 'provider'),
    queries: queries.length ? queries : undefined,
    groups: groups.length ? groups : undefined,
    targets: targets.length ? targets : undefined,
    wait: getBoolean(input.values, 'wait'),
    location: getString(input.values, 'location'),
    allLocations: getBoolean(input.values, 'all-locations'),
    noLocation: getBoolean(input.values, 'no-location'),
    probe: getBoolean(input.values, 'probe'),
    format: input.format,
  })
}

export const RUN_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['run', 'show'],
    usage: 'canonry run show <id> [--format json]',
    run: async (input) => {
      const id = requirePositional(input, 0, {
        command: 'run.show',
        usage: 'canonry run show <id> [--format json]',
        message: 'run ID is required',
      })
      await showRun(id, input.format)
    },
  },
  {
    path: ['run', 'cancel'],
    usage: 'canonry run cancel <project> [run-id] [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'run.cancel', 'canonry run cancel <project> [run-id] [--format json]')
      await cancelRun(project, input.positionals[1], input.format)
    },
  },
  {
    path: ['run', 'trigger'],
    usage: RUN_TRIGGER_USAGE,
    options: RUN_TRIGGER_OPTIONS,
    run: (input) => triggerRunCommand(
      // `canonry run trigger` with nothing after it is ambiguous: the
      // subcommand with no project, or the older form naming a project called
      // "trigger". Nobody types the subcommand without a project, and a project
      // whose name collides with a keyword still has to be runnable, so the
      // project wins and the word is handed back as the positional.
      input.positionals.length === 0 && !getBoolean(input.values, 'all')
        ? { ...input, positionals: ['trigger'] }
        : input,
      'run.trigger',
    ),
  },
  {
    path: ['run'],
    usage: RUN_USAGE,
    options: RUN_TRIGGER_OPTIONS,
    run: (input) => triggerRunCommand(input, 'run'),
  },
  {
    path: ['runs'],
    usage: RUNS_USAGE,
    options: {
      limit: stringOption(),
      kind: stringOption(),
      status: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'runs', RUNS_USAGE)
      // kind/status pass through as typed; the server validates them against
      // the run enums and its 400 names the allowed values.
      await listRuns(project, {
        format: input.format,
        limit: parseIntegerOption(input, 'limit', {
          command: 'runs',
          usage: RUNS_USAGE,
          message: '--limit must be an integer',
        }),
        kind: getString(input.values, 'kind'),
        status: getString(input.values, 'status'),
      })
    },
  },
]
