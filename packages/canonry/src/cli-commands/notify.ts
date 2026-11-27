import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, requirePositional, requireProject, requireStringOption, stringOption, unknownSubcommand } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const UPDATE_USAGE = 'canonry notify update <project> <id> [--events <list> | --add-events <list> --remove-events <list>] [--enable | --disable] [--format json]'

/** A comma-separated event list, or undefined when the flag was not given. */
function eventList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value.split(',').map(entry => entry.trim()).filter(Boolean)
}

export const NOTIFY_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['notify', 'events'],
    usage: 'canonry notify events [--target local|server] [--format json|jsonl]',
    options: { target: stringOption() },
    run: async (input) => {
      const { listEvents } = await import('../commands/notify.js')
      await listEvents(input.format, getString(input.values, 'target'))
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
      const { addNotification } = await import('../commands/notify.js')
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
      const { listNotifications } = await import('../commands/notify.js')
      const project = requireProject(input, 'notify.list', 'canonry notify list <project> [--format json]')
      await listNotifications(project, input.format)
    },
  },
  {
    path: ['notify', 'remove'],
    usage: 'canonry notify remove <project> <id> [--format json]',
    run: async (input) => {
      const { removeNotification } = await import('../commands/notify.js')
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
    path: ['notify', 'update'],
    usage: UPDATE_USAGE,
    options: {
      events: stringOption(),
      'add-events': stringOption(),
      'remove-events': stringOption(),
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
    },
    run: async (input) => {
      const { updateNotification } = await import('../commands/notify.js')
      const project = requireProject(input, 'notify.update', UPDATE_USAGE)
      const id = requirePositional(input, 1, {
        command: 'notify.update',
        usage: UPDATE_USAGE,
        message: 'notification ID is required',
      })
      const enable = getBoolean(input.values, 'enable')
      const disable = getBoolean(input.values, 'disable')
      if (enable && disable) {
        throw usageError(`Error: use --enable or --disable, not both\nUsage: ${UPDATE_USAGE}`, {
          message: 'use --enable or --disable, not both',
          details: { command: 'notify.update', usage: UPDATE_USAGE },
        })
      }
      const events = eventList(getString(input.values, 'events'))
      const addEvents = eventList(getString(input.values, 'add-events'))
      const removeEvents = eventList(getString(input.values, 'remove-events'))
      if (!events && !addEvents && !removeEvents && !enable && !disable) {
        throw usageError(`Error: name a change: --events, --add-events, --remove-events, --enable or --disable\nUsage: ${UPDATE_USAGE}`, {
          message: 'name a change: --events, --add-events, --remove-events, --enable or --disable',
          details: { command: 'notify.update', usage: UPDATE_USAGE },
        })
      }
      await updateNotification(project, id, {
        events,
        addEvents,
        removeEvents,
        ...(enable ? { enabled: true } : disable ? { enabled: false } : {}),
        format: input.format,
      })
    },
  },
  {
    path: ['notify', 'test'],
    usage: 'canonry notify test <project> <id> [--format json]',
    run: async (input) => {
      const { testNotification } = await import('../commands/notify.js')
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
    usage: 'canonry notify <add|list|update|remove|test|events> [project]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'notify',
        usage: 'canonry notify <add|list|update|remove|test|events> [project]',
        available: ['add', 'list', 'update', 'remove', 'test', 'events'],
      })
    },
  },
]
