import { WINDOW_SETS, trendSurfaceSchema, type MetricsWindow } from '@canonry/canonry-contracts'
import { usageError } from '../cli-error.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, stringOption } from '../cli-command-helpers.js'

const USAGE = 'canonry trends <project> --surface index-coverage|site-health|backlinks [--window 7d|30d|90d|all] [--format json]'

const isMetricsWindow = (value: string): value is MetricsWindow => (WINDOW_SETS.metrics as readonly string[]).includes(value)

export const TRENDS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['trends'],
    usage: USAGE,
    help: 'Read a dashboard trend card from stored data: each figure\'s latest reading, its change since the first reading in the window, and its readings. index-coverage covers Google and Bing indexed pages, site-health the site score per scan, backlinks referring domains per Common Crawl release (crawler and proxy hosts left out). The window ends on the latest reading; it defaults to 90d for index-coverage and all otherwise.',
    options: {
      surface: stringOption(),
      window: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'trends', USAGE)
      const surfaceValue = getString(input.values, 'surface')
      const surface = trendSurfaceSchema.safeParse(surfaceValue)
      if (!surface.success) {
        const message = `--surface must be one of: ${trendSurfaceSchema.options.join(', ')}`
        throw usageError(`Error: ${message}\nUsage: ${USAGE}`, {
          message,
          details: { command: 'trends', usage: USAGE, option: 'surface', value: surfaceValue ?? null },
        })
      }
      const windowValue = getString(input.values, 'window')
      if (windowValue !== undefined && !isMetricsWindow(windowValue)) {
        const message = `--window must be one of: ${WINDOW_SETS.metrics.join(', ')}`
        throw usageError(`Error: ${message}\nUsage: ${USAGE}`, {
          message,
          details: { command: 'trends', usage: USAGE, option: 'window', value: windowValue },
        })
      }
      const { trendsCommand } = await import('../commands/trends.js')
      await trendsCommand(project, { surface: surface.data, window: windowValue, format: input.format })
    },
  },
]
