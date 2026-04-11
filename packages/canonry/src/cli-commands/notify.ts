import { addNotification, listEvents, listNotifications, removeNotification, testNotification } from '../commands/notify.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { requirePositional, requireProject, requireStringOption, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

export const NOTIFY_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['notify', 'events'],
    usage: 'canonry notify events [--format json]',
    run: async (input) => {
      await listEvents(input.format)
    },
  },
  {
    path: ['notify', 'add'],
    usage: 'canonry notify add <project> --webhook <url> --events <list> [--format json]',
    options: {
      webhook: stringOption(),
      events: stringOption(),
    },
    run: async (input) => {
      const project = requireProject(input, 'notify.add', 'canonry notify add <project> --webhook <url> --events <list> [--format json]')
      const webhook = requireStringOption(input, 'webhook', {
        command: 'notify.add',
        usage: 'canonry notify add <project> --webhook <url> --events <list> [--format json]',
        message: '--webhook is required',
      })
      const events = requireStringOption(input, 'events', {
        command: 'notify.add',
        usage: 'canonry notify add <project> --webhook <url> --events <list> [--format json]',
        message: '--events is required (comma-separated). Use "canonry notify events" to see valid events.',
      })
      await addNotification(project, {
        webhook,
        events: events.split(',').map(entry => entry.trim()).filter(Boolean),
        format: input.format,
      })
    },
  },
  {
    path: ['notify', 'list'],
    usage: 'canonry notify list <project> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'notify.list', 'canonry notify list <project> [--format json]')
      await listNotifications(project, input.format)
    },
  },
  {
    path: ['notify', 'remove'],
    usage: 'canonry notify remove <project> <id> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'notify.remove', 'canonry notify remove <project> <id> [--format json]')
      const id = requirePositional(input, 1, {
        command: 'notify.remove',
        usage: 'canonry notify remove <project> <id> [--format json]',
        message: 'notification ID is required',
      })
      await removeNotification(project, id, input.format)
    },
  },
  {
    path: ['notify', 'test'],
    usage: 'canonry notify test <project> <id> [--format json]',
    run: async (input) => {
      const project = requireProject(input, 'notify.test', 'canonry notify test <project> <id> [--format json]')
      const id = requirePositional(input, 1, {
        command: 'notify.test',
        usage: 'canonry notify test <project> <id> [--format json]',
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
