import { addNotification, listEvents, listNotifications, removeNotification, testNotification } from '../commands/notify.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { requirePositional, requireProject, requireStringOption, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { openCloudflaredTunnel } from '../commands/tunnel.js'
import { loadConfig } from '../config.js'

export const NOTIFY_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['notify', 'events'],
    usage: 'canonry notify events',
    run: async (input) => {
      listEvents(input.format)
    },
  },
  {
    path: ['notify', 'add'],
    usage: 'canonry notify add <project> --webhook <url> --events <list> [--format json]'
      + '\n       canonry notify add <project> --tunnel --events <list>',
    options: {
      webhook: stringOption(),
      events: stringOption(),
      tunnel: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'notify.add',
        'canonry notify add <project> --webhook <url> --events <list> | --tunnel',
      )

      const useTunnel = input.values.tunnel === true
      const webhookRaw = input.values.webhook

      if (!useTunnel && !webhookRaw) {
        throw new Error('Error: --webhook or --tunnel is required. See --help for usage.')
      }

      if (useTunnel && webhookRaw) {
        throw new Error('Error: --webhook and --tunnel cannot be used together.')
      }

      const events = requireStringOption(input, 'events', {
        command: 'notify.add',
        usage: 'canonry notify add <project> --webhook <url> --events <list> | --tunnel',
        message: '--events is required (comma-separated). Use "canonry notify events" to see valid events.',
      })

      let webhookUrl: string
      if (useTunnel) {
        process.stderr.write('Spawning cloudflared quicktunnel to local canonry server...\n')
        const config = loadConfig()
        const targetUrl = `http://localhost:${config.port ?? 4100}`
        webhookUrl = await openCloudflaredTunnel(targetUrl)
        process.stderr.write(`  Tunnel ready: ${webhookUrl}\n`)
        process.stderr.write('  The tunnel URL is temporary — it only works while cloudflared is running.\n\n')
      } else {
        webhookUrl = requireStringOption(input, 'webhook', {
          command: 'notify.add',
          usage: 'canonry notify add <project> --webhook <url> --events <list>',
          message: '--webhook is required',
        })
      }

      await addNotification(project, {
        webhook: webhookUrl,
        events: events.split(',').map(entry => entry.trim()).filter(Boolean),
        format: input.format,
      })
    },
  },
  {
    path: ['notify', 'list'],
    usage: 'canonry notify list <project>',
    run: async (input) => {
      const project = requireProject(input, 'notify.list', 'canonry notify list <project>')
      await listNotifications(project, input.format)
    },
  },
  {
    path: ['notify', 'remove'],
    usage: 'canonry notify remove <project> <id>',
    run: async (input) => {
      const project = requireProject(input, 'notify.remove', 'canonry notify remove <project> <id>')
      const id = requirePositional(input, 1, {
        command: 'notify.remove',
        usage: 'canonry notify remove <project> <id>',
        message: 'notification ID is required',
      })
      await removeNotification(project, id, input.format)
    },
  },
  {
    path: ['notify', 'test'],
    usage: 'canonry notify test <project> <id>',
    run: async (input) => {
      const project = requireProject(input, 'notify.test', 'canonry notify test <project> <id>')
      const id = requirePositional(input, 1, {
        command: 'notify.test',
        usage: 'canonry notify test <project> <id>',
        message: 'notification ID is required',
      })
      await testNotification(project, id, input.format)
    },
  },
  {
    path: ['notify'],
    usage: 'canonry notify <add|list|remove|test|events> [project]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'notify',
        usage: 'canonry notify <add|list|remove|test|events> [project]',
        available: ['add', 'list', 'remove', 'test', 'events'],
      })
    },
  },
]
