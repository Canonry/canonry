import {
  discoverHarvest,
  discoverList,
  discoverProbe,
  discoverPromote,
  discoverPromotePreview,
  discoverRun,
  discoverSeed,
  discoverShow,
} from '../commands/discover.js'
import { discoverEval } from '../commands/discover-eval.js'
import {
  discoveryBucketSchema,
  discoveryCompetitorTypeSchema,
  type DiscoveryBucket,
  type DiscoveryCompetitorType,
} from '@ainyc/canonry-contracts'
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

function parseLocationsOption(values: CliValues): string[] | undefined {
  const raw = getStringArray(values, 'locations')
  if (!raw || raw.length === 0) return undefined
  // Accept both repeated flags (--locations michigan --locations florida) and
  // comma-separated values (--locations michigan,florida), mirroring --bucket.
  // Labels are validated server-side against the project's configured
  // locations, so there is no enum check here.
  const expanded = raw.flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean)
  return expanded.length > 0 ? expanded : undefined
}

function parseBucketsOption(values: CliValues, usage: string): DiscoveryBucket[] | undefined {
  const raw = getStringArray(values, 'bucket')
  if (!raw || raw.length === 0) return undefined
  // Accept both repeated flags (--bucket cited --bucket aspirational) and
  // comma-separated values (--bucket cited,aspirational).
  const expanded = raw.flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean)
  if (expanded.length === 0) {
    throw usageError(
      `Error: --bucket must include at least one value (valid: cited, aspirational, wasted-surface)\nUsage: ${usage}`,
      {
        message: '--bucket must include at least one value',
        details: { command: 'discover.promote', usage, option: 'bucket', value: raw },
      },
    )
  }
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

const COMPETITOR_TYPE_VALUES = 'direct-competitor, ota-aggregator, editorial-media, other, unknown'

function parseCompetitorTypesOption(values: CliValues, usage: string): DiscoveryCompetitorType[] | undefined {
  const raw = getStringArray(values, 'competitor-types')
  if (!raw || raw.length === 0) return undefined
  // Accept both repeated flags and comma-separated values, mirroring --bucket.
  const expanded = raw.flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean)
  if (expanded.length === 0) {
    throw usageError(
      `Error: --competitor-types must include at least one value (valid: ${COMPETITOR_TYPE_VALUES})\nUsage: ${usage}`,
      {
        message: '--competitor-types must include at least one value',
        details: { command: 'discover.promote', usage, option: 'competitor-types', value: raw },
      },
    )
  }
  const types: DiscoveryCompetitorType[] = []
  for (const value of expanded) {
    const parsed = discoveryCompetitorTypeSchema.safeParse(value)
    if (!parsed.success) {
      throw usageError(
        `Error: invalid --competitor-types value "${value}" (valid: ${COMPETITOR_TYPE_VALUES})\nUsage: ${usage}`,
        {
          message: `invalid --competitor-types value "${value}"`,
          details: { command: 'discover.promote', usage, option: 'competitor-types', value },
        },
      )
    }
    types.push(parsed.data)
  }
  return types
}

export const DISCOVER_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['discover', 'run'],
    usage:
      'canonry discover run <project> [--icp "..."] [--buyer "..."] [--seed-provider gemini --seed-provider openai] [--icp-angle "..."] [--locations michigan,florida] [--dedup-threshold 0.95] [--max-probes 100] [--probe-concurrency 3] [--wait] [--format json]',
    options: {
      icp: stringOption(),
      buyer: stringOption(),
      'seed-provider': multiStringOption(),
      'icp-angle': multiStringOption(),
      locations: multiStringOption(),
      'dedup-threshold': stringOption(),
      'max-probes': stringOption(),
      'probe-concurrency': stringOption(),
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const usage =
        'canonry discover run <project> [--icp "..."] [--buyer "..."] [--seed-provider gemini --seed-provider openai] [--icp-angle "..."] [--locations michigan,florida] [--dedup-threshold 0.95] [--max-probes 100] [--probe-concurrency 3] [--wait] [--format json]'
      const project = requireProject(input, 'discover.run', usage)
      await discoverRun(project, {
        icp: getString(input.values, 'icp'),
        buyer: getString(input.values, 'buyer'),
        seedProviders: getStringArray(input.values, 'seed-provider'),
        icpAngles: getStringArray(input.values, 'icp-angle'),
        locations: parseLocationsOption(input.values),
        dedupThreshold: parseFloatOption(input.values, 'dedup-threshold', usage),
        maxProbes: parseIntegerOption(input, 'max-probes', {
          command: 'discover.run',
          usage,
          message: '--max-probes must be an integer',
        }),
        probeConcurrency: parseIntegerOption(input, 'probe-concurrency', {
          command: 'discover.run',
          usage,
          message: '--probe-concurrency must be an integer',
        }),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['discover', 'eval'],
    usage:
      'canonry discover eval [--baseline <path>] [--update-baseline] [--shape eval-b2b-saas ...] [--seed-provider gemini --seed-provider openai] [--max-probes 2] [--probe-concurrency 2] [--format json]',
    options: {
      baseline: stringOption(),
      'update-baseline': { type: 'boolean', default: false },
      shape: multiStringOption(),
      'seed-provider': multiStringOption(),
      'max-probes': stringOption(),
      'probe-concurrency': stringOption(),
    },
    run: async (input) => {
      const usage =
        'canonry discover eval [--baseline <path>] [--update-baseline] [--shape eval-b2b-saas ...] [--seed-provider gemini --seed-provider openai] [--max-probes 2] [--probe-concurrency 2] [--format json]'
      await discoverEval({
        baseline: getString(input.values, 'baseline'),
        updateBaseline: getBoolean(input.values, 'update-baseline'),
        shapes: getStringArray(input.values, 'shape'),
        seedProviders: getStringArray(input.values, 'seed-provider') as Array<'gemini' | 'openai'> | undefined,
        maxProbes: parseIntegerOption(input, 'max-probes', {
          command: 'discover.eval',
          usage,
          message: '--max-probes must be an integer',
        }),
        probeConcurrency: parseIntegerOption(input, 'probe-concurrency', {
          command: 'discover.eval',
          usage,
          message: '--probe-concurrency must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['discover', 'seed'],
    usage:
      'canonry discover seed <project> [--icp "..."] [--buyer "..."] [--seed-provider gemini --seed-provider openai] [--icp-angle "..."] [--locations michigan,florida] [--dedup-threshold 0.95] [--max-probes 100] [--probe-concurrency 3] [--wait] [--format json]',
    options: {
      icp: stringOption(),
      buyer: stringOption(),
      'seed-provider': multiStringOption(),
      'icp-angle': multiStringOption(),
      locations: multiStringOption(),
      'dedup-threshold': stringOption(),
      'max-probes': stringOption(),
      'probe-concurrency': stringOption(),
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const usage =
        'canonry discover seed <project> [--icp "..."] [--buyer "..."] [--seed-provider gemini --seed-provider openai] [--icp-angle "..."] [--locations michigan,florida] [--dedup-threshold 0.95] [--max-probes 100] [--probe-concurrency 3] [--wait] [--format json]'
      const project = requireProject(input, 'discover.seed', usage)
      await discoverSeed(project, {
        icp: getString(input.values, 'icp'),
        buyer: getString(input.values, 'buyer'),
        seedProviders: getStringArray(input.values, 'seed-provider'),
        icpAngles: getStringArray(input.values, 'icp-angle'),
        locations: parseLocationsOption(input.values),
        dedupThreshold: parseFloatOption(input.values, 'dedup-threshold', usage),
        maxProbes: parseIntegerOption(input, 'max-probes', {
          command: 'discover.seed',
          usage,
          message: '--max-probes must be an integer',
        }),
        probeConcurrency: parseIntegerOption(input, 'probe-concurrency', {
          command: 'discover.seed',
          usage,
          message: '--probe-concurrency must be an integer',
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
      'canonry discover promote <project> <session-id> [--bucket cited,aspirational,wasted-surface] [--competitor-types direct-competitor,editorial-media] [--no-competitors] [--format json]',
    options: {
      bucket: multiStringOption(),
      'competitor-types': multiStringOption(),
      'no-competitors': { type: 'boolean', default: false },
    },
    run: async (input) => {
      const usage =
        'canonry discover promote <project> <session-id> [--bucket cited,aspirational,wasted-surface] [--competitor-types direct-competitor,editorial-media] [--no-competitors] [--format json]'
      const project = requireProject(input, 'discover.promote', usage)
      const sessionId = requirePositional(input, 1, {
        command: 'discover.promote',
        usage,
        message: 'session ID is required',
      })
      await discoverPromote(project, sessionId, {
        buckets: parseBucketsOption(input.values, usage),
        competitorTypes: parseCompetitorTypesOption(input.values, usage),
        includeCompetitors: !getBoolean(input.values, 'no-competitors'),
        format: input.format,
      })
    },
  },
  {
    path: ['discover', 'harvest'],
    usage:
      'canonry discover harvest <project> <session-id> [--min-probe-hits <n>] [--no-anchor] [--format json|jsonl]',
    options: {
      'min-probe-hits': stringOption(),
      'no-anchor': { type: 'boolean', default: false },
    },
    run: async (input) => {
      const usage =
        'canonry discover harvest <project> <session-id> [--min-probe-hits <n>] [--no-anchor] [--format json|jsonl]'
      const project = requireProject(input, 'discover.harvest', usage)
      const sessionId = requirePositional(input, 1, {
        command: 'discover.harvest',
        usage,
        message: 'session ID is required',
      })
      await discoverHarvest(project, sessionId, {
        minProbeHits: parseIntegerOption(input, 'min-probe-hits', {
          command: 'discover.harvest',
          usage,
          message: '--min-probe-hits must be an integer',
        }),
        anchor: !getBoolean(input.values, 'no-anchor'),
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
