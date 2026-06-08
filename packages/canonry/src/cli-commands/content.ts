import {
  listContentTargets,
  listContentSources,
  listContentGaps,
  generateContentBrief,
  contentMap,
} from '../commands/content.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { requireProject, requirePositional, parseIntegerOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'
import { winnabilityClassSchema } from '@ainyc/canonry-contracts'

export const CONTENT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['content', 'targets'],
    usage:
      'canonry content targets <project> [--limit <n>] [--include-in-progress] [--ownable] [--surface-class <ownable|ceded>] [--format json]',
    options: {
      limit: { type: 'string' },
      'include-in-progress': { type: 'boolean' },
      ownable: { type: 'boolean' },
      'surface-class': { type: 'string' },
    },
    run: async (input) => {
      const usage =
        'canonry content targets <project> [--limit <n>] [--include-in-progress] [--ownable] [--surface-class <ownable|ceded>] [--format json]'
      const project = requireProject(input, 'content targets', usage)
      const limit = parseIntegerOption(input, 'limit', {
        command: 'content targets',
        usage,
        message: '--limit must be a non-negative integer',
      })
      const rawSurfaceClass = input.values['surface-class']
      let winnabilityClass: 'ownable' | 'ceded' | undefined
      if (typeof rawSurfaceClass === 'string') {
        const parsed = winnabilityClassSchema.safeParse(rawSurfaceClass)
        if (!parsed.success) {
          throw usageError('Error: --surface-class must be "ownable" or "ceded"', { message: usage })
        }
        winnabilityClass = parsed.data
      }
      await listContentTargets(project, {
        limit,
        includeInProgress: input.values['include-in-progress'] === true,
        ownable: input.values.ownable === true,
        winnabilityClass,
        format: input.format,
      })
    },
  },
  {
    path: ['content', 'sources'],
    usage: 'canonry content sources <project> [--format json]',
    options: {},
    run: async (input) => {
      const usage = 'canonry content sources <project> [--format json]'
      const project = requireProject(input, 'content sources', usage)
      await listContentSources(project, { format: input.format })
    },
  },
  {
    path: ['content', 'gaps'],
    usage: 'canonry content gaps <project> [--format json]',
    options: {},
    run: async (input) => {
      const usage = 'canonry content gaps <project> [--format json]'
      const project = requireProject(input, 'content gaps', usage)
      await listContentGaps(project, { format: input.format })
    },
  },
  {
    path: ['content', 'brief'],
    usage:
      'canonry content brief <project> <targetRef> [--provider <p>] [--model <m>] [--force] [--format json]',
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      force: { type: 'boolean' },
    },
    run: async (input) => {
      const usage =
        'canonry content brief <project> <targetRef> [--provider <p>] [--model <m>] [--force] [--format json]'
      const project = requireProject(input, 'content brief', usage)
      const targetRef = requirePositional(input, 1, {
        command: 'content brief',
        usage,
        message: 'targetRef is required (from `canonry content targets`)',
      })
      await generateContentBrief(project, targetRef, {
        provider: typeof input.values.provider === 'string' ? input.values.provider : undefined,
        model: typeof input.values.model === 'string' ? input.values.model : undefined,
        force: input.values.force === true,
        format: input.format,
      })
    },
  },
  {
    path: ['content', 'map'],
    usage: 'canonry content map <project> [--format json]',
    options: {},
    run: async (input) => {
      const usage = 'canonry content map <project> [--format json]'
      const project = requireProject(input, 'content map', usage)
      await contentMap(project, { format: input.format })
    },
  },
]
