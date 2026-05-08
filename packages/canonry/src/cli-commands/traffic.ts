import { trafficConnectCloudRun, trafficSync } from '../commands/traffic.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

export const TRAFFIC_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['traffic', 'connect', 'cloud-run'],
    usage: 'canonry traffic connect cloud-run <project> --gcp-project <id> --service-account-key <path> [--service <name>] [--location <region>] [--display-name <name>] [--format json]',
    options: {
      'gcp-project': stringOption(),
      service: stringOption(),
      location: stringOption(),
      'service-account-key': stringOption(),
      'display-name': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.connect.cloud-run',
        'canonry traffic connect cloud-run <project> --gcp-project <id> --service-account-key <path>',
      )
      const gcpProject = getString(input.values, 'gcp-project')
      if (!gcpProject) throw new Error('--gcp-project is required')
      const serviceAccountKey = getString(input.values, 'service-account-key')
      if (!serviceAccountKey) throw new Error('--service-account-key is required')

      await trafficConnectCloudRun(project, {
        gcpProject,
        service: getString(input.values, 'service'),
        location: getString(input.values, 'location'),
        serviceAccountKey,
        displayName: getString(input.values, 'display-name'),
        format: input.format,
      })
    },
  },
  {
    path: ['traffic', 'connect'],
    usage: 'canonry traffic connect <provider> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'traffic connect',
        usage: 'canonry traffic connect <provider> <project> [args]',
        available: ['cloud-run'],
      })
    },
  },
  {
    path: ['traffic', 'sync'],
    usage: 'canonry traffic sync <project> --source <id> [--since-minutes 60] [--format json]',
    options: {
      source: stringOption(),
      'since-minutes': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.sync',
        'canonry traffic sync <project> --source <id> [--since-minutes 60]',
      )
      const source = getString(input.values, 'source')
      if (!source) throw new Error('--source <id> is required')
      const sinceStr = getString(input.values, 'since-minutes')
      const sinceMinutes = sinceStr ? parseInt(sinceStr, 10) : undefined

      await trafficSync(project, {
        source,
        sinceMinutes,
        format: input.format,
      })
    },
  },
  {
    path: ['traffic'],
    usage: 'canonry traffic <subcommand> <project> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'traffic',
        usage: 'canonry traffic <subcommand> <project> [args]',
        available: ['connect', 'sync'],
      })
    },
  },
]
