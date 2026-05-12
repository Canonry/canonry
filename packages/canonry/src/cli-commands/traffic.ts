import {
  trafficBackfill,
  trafficConnectCloudRun,
  trafficConnectWordpress,
  trafficEvents,
  trafficSources,
  trafficStatus,
  trafficSync,
} from '../commands/traffic.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, parseIntegerOption, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

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
    path: ['traffic', 'connect', 'wordpress'],
    usage: 'canonry traffic connect wordpress <project> --url <wp-site-url> --username <wp-user> --app-password <app-password> [--display-name <name>] [--format json]',
    options: {
      url: stringOption(),
      username: stringOption(),
      'app-password': stringOption(),
      'display-name': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.connect.wordpress',
        'canonry traffic connect wordpress <project> --url <wp-site-url> --username <wp-user> --app-password <app-password>',
      )
      const url = getString(input.values, 'url')
      if (!url) throw new Error('--url is required')
      const username = getString(input.values, 'username')
      if (!username) throw new Error('--username is required')
      const appPassword = getString(input.values, 'app-password')
      if (!appPassword) throw new Error('--app-password is required')

      await trafficConnectWordpress(project, {
        url,
        username,
        appPassword,
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
        available: ['cloud-run', 'wordpress'],
      })
    },
  },
  {
    path: ['traffic', 'sync'],
    usage: 'canonry traffic sync <project> --source <id> [--since-minutes 43200] [--format json]',
    options: {
      source: stringOption(),
      'since-minutes': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.sync',
        'canonry traffic sync <project> --source <id> [--since-minutes 43200]',
      )
      const source = getString(input.values, 'source')
      if (!source) throw new Error('--source <id> is required')
      const sinceMinutes = parseIntegerOption(input, 'since-minutes', {
        command: 'traffic.sync',
        usage: 'canonry traffic sync <project> --source <id> [--since-minutes 43200]',
        message: '--since-minutes must be an integer',
      })

      await trafficSync(project, {
        source,
        sinceMinutes,
        format: input.format,
      })
    },
  },
  {
    path: ['traffic', 'backfill'],
    usage: 'canonry traffic backfill <project> --source <id> [--days 30] [--wait] [--format json]',
    options: {
      source: stringOption(),
      days: stringOption(),
      wait: { type: 'boolean' },
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.backfill',
        'canonry traffic backfill <project> --source <id> [--days 30] [--wait]',
      )
      const source = getString(input.values, 'source')
      if (!source) throw new Error('--source <id> is required')
      const days = parseIntegerOption(input, 'days', {
        command: 'traffic.backfill',
        usage: 'canonry traffic backfill <project> --source <id> [--days 30] [--wait]',
        message: '--days must be a positive integer',
      })

      await trafficBackfill(project, {
        source,
        days,
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['traffic', 'sources'],
    usage: 'canonry traffic sources <project> [--format json]',
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.sources',
        'canonry traffic sources <project>',
      )
      await trafficSources(project, { format: input.format })
    },
  },
  {
    path: ['traffic', 'status'],
    usage: 'canonry traffic status <project> [--format json]',
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.status',
        'canonry traffic status <project>',
      )
      await trafficStatus(project, { format: input.format })
    },
  },
  {
    path: ['traffic', 'events'],
    usage: 'canonry traffic events <project> [--kind crawler|ai-referral|all] [--source <id>] [--since-minutes 1440] [--since <iso>] [--until <iso>] [--limit 500] [--format json]',
    options: {
      kind: stringOption(),
      source: stringOption(),
      'since-minutes': stringOption(),
      since: stringOption(),
      until: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.events',
        'canonry traffic events <project>',
      )
      const sinceMinutes = parseIntegerOption(input, 'since-minutes', {
        command: 'traffic.events',
        usage: 'canonry traffic events <project> [--since-minutes 1440]',
        message: '--since-minutes must be an integer',
      })
      const limit = parseIntegerOption(input, 'limit', {
        command: 'traffic.events',
        usage: 'canonry traffic events <project> [--limit 500]',
        message: '--limit must be an integer',
      })

      await trafficEvents(project, {
        kind: getString(input.values, 'kind'),
        source: getString(input.values, 'source'),
        sinceMinutes,
        since: getString(input.values, 'since'),
        until: getString(input.values, 'until'),
        limit,
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
        available: ['connect', 'sync', 'backfill', 'status', 'sources', 'events'],
      })
    },
  },
]
