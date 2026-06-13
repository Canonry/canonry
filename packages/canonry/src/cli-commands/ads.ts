import {
  adsConnect,
  adsDisconnect,
  adsStatus,
  adsSync,
  adsCampaigns,
  adsInsights,
  adsSummary,
} from '../commands/ads.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, stringOption } from '../cli-command-helpers.js'

export const ADS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['ads', 'connect'],
    usage: 'canonry ads connect <project> --api-key <sdk-key> [--format json]',
    options: {
      'api-key': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'ads.connect', 'canonry ads connect <project> --api-key <sdk-key> [--format json]')
      await adsConnect(project, {
        apiKey: getString(input.values, 'api-key'),
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'disconnect'],
    usage: 'canonry ads disconnect <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ads.disconnect', 'canonry ads disconnect <project> [--format json]')
      await adsDisconnect(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'status'],
    usage: 'canonry ads status <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ads.status', 'canonry ads status <project> [--format json]')
      await adsStatus(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'sync'],
    usage: 'canonry ads sync <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ads.sync', 'canonry ads sync <project> [--format json]')
      await adsSync(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'campaigns'],
    usage: 'canonry ads campaigns <project> [--format json|jsonl]',
    run: async (input) => {
      const project = requireProject(input, 'ads.campaigns', 'canonry ads campaigns <project> [--format json|jsonl]')
      await adsCampaigns(project, { format: input.format })
    },
  },
  {
    path: ['ads', 'insights'],
    usage: 'canonry ads insights <project> [--level campaign|ad_group] [--entity <id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--format json|jsonl]',
    options: {
      level: stringOption(),
      entity: stringOption(),
      from: stringOption(),
      to: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'ads.insights', 'canonry ads insights <project> [--level <level>] [--entity <id>] [--from <date>] [--to <date>] [--format json|jsonl]')
      await adsInsights(project, {
        level: getString(input.values, 'level'),
        entity: getString(input.values, 'entity'),
        from: getString(input.values, 'from'),
        to: getString(input.values, 'to'),
        format: input.format,
      })
    },
  },
  {
    path: ['ads', 'summary'],
    usage: 'canonry ads summary <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'ads.summary', 'canonry ads summary <project> [--format json]')
      await adsSummary(project, { format: input.format })
    },
  },
]
