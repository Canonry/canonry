import {
  discoverList,
  discoverProbe,
  discoverPromote,
  discoverPromotePreview,
  discoverRun,
  discoverSeed,
  discoverShow,
} from '../commands/discover.js'
import { discoveryBucketSchema, type DiscoveryBucket } from '@ainyc/canonry-contracts'
import type { CliCommandSpec, CliValues } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  getStringArray,
  multiStringOption,
  parseIntegerOption,
  requirePositional,
  requireProject,
  stringOption,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

function parseFloatOption(values: Record<string, unknown>, key: string, usage: string): number | undefined {
  const raw = values[key]
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const parsed = Number.parseFloat(raw)
  if (Number.isNaN(parsed)) {
    throw usageError(`Error: --${key} must be a number\nUsage: ${usage}`, {
      message: `--${key} must be a number`,
      details: { command: 'discover', usage, option: key, value: raw },
    })
  }
  return parsed
}

function parseBucketsOption(values: CliValues, usage: string): DiscoveryBucket[] | undefined {
  const raw = getStringArray(values, 'bucket')
  if (!raw || raw.length === 0) return undefined
  // Accept both repeated flags (--bucket cited --bucket aspirational) and
  // comma-separated values (--bucket cited,aspirational).
  const expanded = raw.flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean)
  const buckets: DiscoveryBucket[] = []
  for (const value of expanded) {
    const parsed = discoveryBucketSchema.safeParse(value)
    if (!parsed.success) {
      throw usageError(
        `Error: invalid --bucket value "${value}" (valid: cited, aspirational, wasted-surface)\nUsage: ${usage}`,
        {
          message: `invalid --bucket value "${value}"`,
          details: { command: 'discover.promote', usage, option: 'bucket', value },
        },
      )
    }
    buckets.push(parsed.data)
  }
  return buckets
}

export const DISCOVER_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['discover', 'run'],
    usage:
      'canonry discover run <project> [--icp "..."] [--dedup-threshold 0.85] [--max-probes 100] [--wait] [--format json]',
    options: {
      icp: stringOption(),
      'dedup-threshold': stringOption(),
      'max-probes': stringOption(),
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'discover.run',
        'canonry discover run <project> [--icp "..."] [--wait] [--format json]',
      )
      const usage = 'canonry discover run <project> [--icp "..."] [--dedup-threshold 0.85] [--max-probes 100] [--wait] [--format json]'
      await discoverRun(project, {
        icp: getString(input.values, 'icp'),
        dedupThreshold: parseFloatOption(input.values, 'dedup-threshold', usage),
        maxProbes: parseIntegerOption(input, 'max-probes', {
          command: 'discover.run',
          usage,
          message: '--max-probes must be an integer',
        }),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['discover', 'seed'],
    usage:
      'canonry discover seed <project> [--icp "..."] [--dedup-threshold 0.85] [--max-probes 100] [--wait] [--format json]',
    options: {
      icp: stringOption(),
      'dedup-threshold': stringOption(),
      'max-probes': stringOption(),
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'discover.seed',
        'canonry discover seed <project> [--icp "..."] [--wait] [--format json]',
      )
      const usage = 'canonry discover seed <project> [--icp "..."] [--dedup-threshold 0.85] [--max-probes 100] [--wait] [--format json]'
      await discoverSeed(project, {
        icp: getString(input.values, 'icp'),
        dedupThreshold: parseFloatOption(input.values, 'dedup-threshold', usage),
        maxProbes: parseIntegerOption(input, 'max-probes', {
          command: 'discover.seed',
          usage,
          message: '--max-probes must be an integer',
        }),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['discover', 'probe'],
    usage: 'canonry discover probe <project> <session-id> [--format json]',
    run: async (input) => {
      const project = requireProject(
        input,
        'discover.probe',
        'canonry discover probe <project> <session-id> [--format json]',
      )
      const sessionId = requirePositional(input, 1, {
        command: 'discover.probe',
        usage: 'canonry discover probe <project> <session-id> [--format json]',
        message: 'session ID is required',
      })
      await discoverProbe(project, sessionId, { format: input.format })
    },
  },
  {
    path: ['discover', 'list'],
    usage: 'canonry discover list <project> [--limit <n>] [--format json]',
    options: {
      limit: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'discover.list',
        'canonry discover list <project> [--limit <n>] [--format json]',
      )
      await discoverList(project, {
        limit: parseIntegerOption(input, 'limit', {
          command: 'discover.list',
          usage: 'canonry discover list <project> [--limit <n>] [--format json]',
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['discover', 'show'],
    usage: 'canonry discover show <project> <session-id> [--format json]',
    run: async (input) => {
      const project = requireProject(
        input,
        'discover.show',
        'canonry discover show <project> <session-id> [--format json]',
      )
      const sessionId = requirePositional(input, 1, {
        command: 'discover.show',
        usage: 'canonry discover show <project> <session-id> [--format json]',
        message: 'session ID is required',
      })
      await discoverShow(project, sessionId, { format: input.format })
    },
  },
  {
    path: ['discover', 'promote'],
    usage:
      'canonry discover promote <project> <session-id> [--bucket cited,aspirational,wasted-surface] [--no-competitors] [--format json]',
    options: {
      bucket: multiStringOption(),
      'no-competitors': { type: 'boolean', default: false },
    },
    run: async (input) => {
      const usage =
        'canonry discover promote <project> <session-id> [--bucket cited,aspirational,wasted-surface] [--no-competitors] [--format json]'
      const project = requireProject(input, 'discover.promote', usage)
      const sessionId = requirePositional(input, 1, {
        command: 'discover.promote',
        usage,
        message: 'session ID is required',
      })
      await discoverPromote(project, sessionId, {
        buckets: parseBucketsOption(input.values, usage),
        includeCompetitors: !getBoolean(input.values, 'no-competitors'),
        format: input.format,
      })
    },
  },
  {
    path: ['discover', 'promote', 'preview'],
    usage: 'canonry discover promote preview <project> <session-id> [--format json]',
    run: async (input) => {
      const project = requireProject(
        input,
        'discover.promote.preview',
        'canonry discover promote preview <project> <session-id> [--format json]',
      )
      const sessionId = requirePositional(input, 1, {
        command: 'discover.promote.preview',
        usage: 'canonry discover promote preview <project> <session-id> [--format json]',
        message: 'session ID is required',
      })
      await discoverPromotePreview(project, sessionId, { format: input.format })
    },
  },
]
