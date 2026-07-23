import { researchList, researchRun, researchShow } from '../commands/research.js'
import type { CliCommandSpec, CliCommandInput } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  getStringArray,
  multiStringOption,
  parseIntegerOption,
  requireProject,
  requirePositional,
  stringOption,
} from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import { createApiClient } from '../client.js'
import type { LocationContext } from '@ainyc/canonry-contracts'

const RUN_USAGE = 'canonry research run <project> <query...> [--query <text>] [--provider <name>] [--model <id>] [--location <label>|--no-location] [--idempotency-key <key>] [--wait] [--format json|jsonl]'

function normalizeQueries(input: CliCommandInput, usage: string): string[] {
  const positional = input.positionals.slice(1)
  const flagged = getStringArray(input.values, 'query') ?? []
  const seen = new Set<string>()
  const queries: string[] = []
  for (const raw of [...positional, ...flagged]) {
    const query = raw.trim()
    const key = query.toLocaleLowerCase()
    if (query && !seen.has(key)) {
      seen.add(key)
      queries.push(query)
    }
  }
  if (queries.length === 0) {
    throw usageError(`Error: at least one research query is required\nUsage: ${usage}`, {
      message: 'at least one research query is required',
      details: { command: 'research.run', usage },
    })
  }
  if (queries.length > 50) {
    throw usageError(`Error: at most 50 research queries are allowed\nUsage: ${usage}`, {
      message: 'at most 50 research queries are allowed',
      details: { command: 'research.run', usage, queryCount: queries.length },
    })
  }
  return queries
}

function parseResearchLimit(input: CliCommandInput, usage: string): number | undefined {
  const limit = parseIntegerOption(input, 'limit', {
    command: 'research.list',
    usage,
    message: '--limit must be an integer',
  })
  if (limit === undefined) return undefined
  if (limit >= 1 && limit <= 100) return limit
  throw usageError(`Error: --limit must be between 1 and 100\nUsage: ${usage}`, {
    message: '--limit must be between 1 and 100',
    details: { command: 'research.list', usage, option: 'limit', value: limit },
  })
}

async function resolveLocation(
  project: string,
  label: string | undefined,
  noLocation: boolean,
  usage: string,
): Promise<LocationContext | null | undefined> {
  if (label && noLocation) {
    throw usageError(`Error: --location and --no-location cannot be used together\nUsage: ${usage}`, {
      message: '--location and --no-location cannot be used together',
      details: { command: 'research.run', usage },
    })
  }
  if (noLocation) return null
  if (!label) return undefined
  const configured = await createApiClient().getProject(project)
  const location = configured.locations.find(candidate => candidate.label === label)
  if (location) return location
  throw usageError(`Error: location "${label}" is not configured for project "${project}"\nUsage: ${usage}`, {
    message: `location "${label}" is not configured for project "${project}"`,
    details: { command: 'research.run', usage, location: label, project },
  })
}

export const RESEARCH_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['research', 'run'],
    usage: RUN_USAGE,
    options: {
      query: multiStringOption(),
      provider: stringOption(),
      model: stringOption(),
      location: stringOption(),
      'no-location': { type: 'boolean', default: false },
      'idempotency-key': stringOption(),
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(input, 'research.run', RUN_USAGE)
      const provider = getString(input.values, 'provider')?.trim() || undefined
      const model = getString(input.values, 'model')?.trim() || undefined
      if (model && !provider) {
        throw usageError(`Error: --model requires --provider\nUsage: ${RUN_USAGE}`, {
          message: '--model requires --provider',
          details: { command: 'research.run', usage: RUN_USAGE },
        })
      }
      await researchRun(project, {
        queries: normalizeQueries(input, RUN_USAGE),
        provider,
        model,
        location: await resolveLocation(project, getString(input.values, 'location'), getBoolean(input.values, 'no-location'), RUN_USAGE),
        idempotencyKey: getString(input.values, 'idempotency-key')?.trim() || undefined,
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['research', 'list'],
    usage: 'canonry research list <project> [--limit <n>] [--format json|jsonl]',
    options: { limit: stringOption() },
    run: async (input) => {
      const usage = 'canonry research list <project> [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'research.list', usage)
      await researchList(project, {
        limit: parseResearchLimit(input, usage),
        format: input.format,
      })
    },
  },
  {
    path: ['research', 'show'],
    usage: 'canonry research show <project> <run-id> [--format json|jsonl]',
    run: async (input) => {
      const usage = 'canonry research show <project> <run-id> [--format json|jsonl]'
      const project = requireProject(input, 'research.show', usage)
      const runId = requirePositional(input, 1, { command: 'research.show', usage, message: 'research run ID is required' })
      await researchShow(project, runId, { format: input.format })
    },
  },
]
