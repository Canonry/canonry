import {
  trafficBackfill,
  trafficActivate,
  trafficConnectCloudflare,
  trafficConnectCloudRun,
  trafficConnectVercel,
  trafficConnectWordpress,
  trafficEvents,
  trafficReferralAssessment,
  trafficReset,
  trafficSources,
  trafficStatus,
  trafficSync,
} from '../commands/traffic.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, parseIntegerOption, requireProject, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { DEFAULT_CLOUDFLARE_QUEUE_RETENTION_SECONDS } from '../commands/traffic.js'

export const TRAFFIC_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['traffic', 'referral-assessment'],
    usage: 'canonry traffic referral-assessment <project> --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--source <id>] [--burst-threshold 100] [--ratio-threshold 3] [--limit 100] [--format json]',
    help: 'DB-only diagnostic. Raw headlines stay unchanged. Candidate bursts are not confirmed automation; adjusted counts are estimates. Property, Target and market attribution are unavailable. The observed GA quotient has unknown comparable coverage.',
    options: { 'start-date': stringOption(), 'end-date': stringOption(), source: stringOption(), 'burst-threshold': stringOption(), 'ratio-threshold': stringOption(), limit: stringOption() },
    run: async input => {
      const project = requireProject(input, 'traffic.referral-assessment', 'canonry traffic referral-assessment <project> --start-date YYYY-MM-DD --end-date YYYY-MM-DD')
      await trafficReferralAssessment(project, {
        startDate: getString(input.values, 'start-date'), endDate: getString(input.values, 'end-date'), sourceId: getString(input.values, 'source'),
        burstThreshold: getString(input.values, 'burst-threshold') === undefined ? undefined : Number(getString(input.values, 'burst-threshold')),
        ratioThreshold: getString(input.values, 'ratio-threshold') === undefined ? undefined : Number(getString(input.values, 'ratio-threshold')),
        limit: getString(input.values, 'limit') === undefined ? undefined : Number(getString(input.values, 'limit')),
        format: input.format,
      })
    },
  },

  {
    path: ['traffic', 'connect', 'cloudflare'],
    usage: 'canonry traffic connect cloudflare <project> [--delivery-mode direct-push|queue-pull] [--display-name <name>] [--zone-id <id>] [--account-id <id>] [--queue-id <id> --queue-name <name> --api-token-file <path> --retention-seconds 345600] [--output-dir <dir>] [--deploy --confirm-route --confirm-fail-open] [--format json]',
    options: {
      'display-name': stringOption(),
      'zone-id': stringOption(),
      'account-id': stringOption(),
      'delivery-mode': stringOption(),
      'queue-id': stringOption(),
      'queue-name': stringOption(),
      'api-token-file': stringOption(),
      'retention-seconds': stringOption(),
      'output-dir': stringOption(),
      deploy: { type: 'boolean' },
      'confirm-route': { type: 'boolean' },
      'confirm-fail-open': { type: 'boolean' },
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.connect.cloudflare',
        'canonry traffic connect cloudflare <project> [--delivery-mode direct-push|queue-pull] [--zone-id <id>] [--output-dir <dir>] [--deploy --confirm-route --confirm-fail-open]',
      )
      const deliveryMode = getString(input.values, 'delivery-mode') ?? 'direct-push'
      if (deliveryMode !== 'direct-push' && deliveryMode !== 'queue-pull') {
        throw new Error('--delivery-mode must be direct-push or queue-pull')
      }
      const retentionSeconds = parseIntegerOption(input, 'retention-seconds', {
        command: 'traffic.connect.cloudflare',
        usage: 'canonry traffic connect cloudflare <project> --delivery-mode queue-pull --retention-seconds 345600',
        message: '--retention-seconds must be an integer',
      })
      await trafficConnectCloudflare(project, {
        deliveryMode,
        displayName: getString(input.values, 'display-name'),
        zoneId: getString(input.values, 'zone-id'),
        accountId: getString(input.values, 'account-id'),
        queueId: getString(input.values, 'queue-id'),
        queueName: getString(input.values, 'queue-name'),
        apiTokenFile: getString(input.values, 'api-token-file'),
        retentionSeconds: retentionSeconds ?? DEFAULT_CLOUDFLARE_QUEUE_RETENTION_SECONDS,
        outputDirectory: getString(input.values, 'output-dir'),
        deploy: getBoolean(input.values, 'deploy'),
        confirmRoute: getBoolean(input.values, 'confirm-route'),
        confirmFailOpen: getBoolean(input.values, 'confirm-fail-open'),
        format: input.format,
      })
    },
  },
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
    usage: 'canonry traffic connect wordpress <project> --url <wp-site-url> --username <wp-user> (--app-password <pw> | --app-password-file <path>) [--display-name <name>] [--format json]',
    options: {
      url: stringOption(),
      username: stringOption(),
      'app-password': stringOption(),
      'app-password-file': stringOption(),
      'display-name': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.connect.wordpress',
        'canonry traffic connect wordpress <project> --url <wp-site-url> --username <wp-user> (--app-password <pw> | --app-password-file <path>)',
      )
      const url = getString(input.values, 'url')
      if (!url) throw new Error('--url is required')
      const username = getString(input.values, 'username')
      if (!username) throw new Error('--username is required')

      await trafficConnectWordpress(project, {
        url,
        username,
        appPassword: getString(input.values, 'app-password'),
        appPasswordFile: getString(input.values, 'app-password-file'),
        displayName: getString(input.values, 'display-name'),
        format: input.format,
      })
    },
  },
  {
    path: ['traffic', 'connect', 'vercel'],
    usage: 'canonry traffic connect vercel <project> --project-id <prj> --team-id <team> (--token <token> | --token-file <path>) [--environment production|preview] [--display-name <name>] [--format json]',
    options: {
      'project-id': stringOption(),
      'team-id': stringOption(),
      token: stringOption(),
      'token-file': stringOption(),
      environment: stringOption(),
      'display-name': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.connect.vercel',
        'canonry traffic connect vercel <project> --project-id <prj> --team-id <team> (--token <token> | --token-file <path>)',
      )
      const projectId = getString(input.values, 'project-id')
      if (!projectId) throw new Error('--project-id is required')
      const teamId = getString(input.values, 'team-id')
      if (!teamId) throw new Error('--team-id is required')

      await trafficConnectVercel(project, {
        projectId,
        teamId,
        token: getString(input.values, 'token'),
        tokenFile: getString(input.values, 'token-file'),
        environment: getString(input.values, 'environment'),
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
        available: ['cloud-run', 'cloudflare', 'wordpress', 'vercel'],
      })
    },
  },
  {
    path: ['traffic', 'activate'],
    usage: 'canonry traffic activate <project> --source <id> [--format json]',
    options: {
      source: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.activate',
        'canonry traffic activate <project> --source <id>',
      )
      const sourceId = getString(input.values, 'source')
      if (!sourceId) throw new Error('--source <id> is required')
      await trafficActivate(project, { sourceId, format: input.format })
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
    path: ['traffic', 'reset'],
    usage: 'canonry traffic reset <project> --source <id> --advance-to-now [--format json]',
    options: {
      source: stringOption(),
      'advance-to-now': { type: 'boolean' },
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'traffic.reset',
        'canonry traffic reset <project> --source <id> --advance-to-now',
      )
      const source = getString(input.values, 'source')
      if (!source) throw new Error('--source <id> is required')

      await trafficReset(project, {
        source,
        advanceToNow: getBoolean(input.values, 'advance-to-now'),
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
    usage: 'canonry traffic events <project> [--kind crawler|ai-user-fetch|ai-referral|all] [--source <id>] [--since-minutes 1440] [--since <iso>] [--until <iso>] [--limit 500] [--granularity hour|day] [--format json]',
    options: {
      kind: stringOption(),
      source: stringOption(),
      'since-minutes': stringOption(),
      since: stringOption(),
      until: stringOption(),
      limit: stringOption(),
      granularity: stringOption(),
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
        granularity: getString(input.values, 'granularity'),
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
        available: ['connect', 'activate', 'sync', 'backfill', 'status', 'sources', 'events'],
      })
    },
  },
]
