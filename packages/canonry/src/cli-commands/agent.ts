import { agentStatus, agentStart, agentStop, agentReset, agentSetup } from '../commands/agent.js'
import type { CliCommandSpec } from '../cli-dispatch.js'

export const AGENT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['agent', 'status'],
    usage: 'canonry agent status [--format json]',
    options: {},
    run: async (input) => {
      await agentStatus({ format: input.format })
    },
  },
  {
    path: ['agent', 'start'],
    usage: 'canonry agent start [--format json]',
    options: {},
    run: async (input) => {
      await agentStart({ format: input.format })
    },
  },
  {
    path: ['agent', 'stop'],
    usage: 'canonry agent stop [--format json]',
    options: {},
    run: async (input) => {
      await agentStop({ format: input.format })
    },
  },
  {
    path: ['agent', 'reset'],
    usage: 'canonry agent reset [--format json]',
    options: {},
    run: async (input) => {
      await agentReset({ format: input.format })
    },
  },
  {
    path: ['agent', 'setup'],
    usage: 'canonry agent setup [--install] [--gateway-port <port>] [--format json]',
    options: {
      install: { type: 'boolean' },
      'gateway-port': { type: 'string' },
    },
    run: async (input) => {
      const portStr = input.values['gateway-port']
      const gatewayPort = typeof portStr === 'string' ? Number.parseInt(portStr, 10) : undefined
      await agentSetup({
        install: input.values.install === true,
        gatewayPort,
        format: input.format,
      })
    },
  },
]
