import { agentStatus, agentStart, agentStop, agentReset, agentSetup } from '../commands/agent.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, stringOption } from '../cli-command-helpers.js'

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
    usage: 'canonry agent setup [--agent-provider <id>] [--agent-key <key>] [--agent-model <model>] [--gateway-port <port>] [--gemini-key <key>] [--openai-key <key>] [--claude-key <key>] [--perplexity-key <key>] [--format json]',
    options: {
      'agent-provider': stringOption(),
      'agent-key': stringOption(),
      'agent-model': stringOption(),
      'gateway-port': { type: 'string' },
      'gemini-key': stringOption(),
      'openai-key': stringOption(),
      'claude-key': stringOption(),
      'perplexity-key': stringOption(),
      'local-url': stringOption(),
      'local-model': stringOption(),
      'local-key': stringOption(),
      'google-client-id': stringOption(),
      'google-client-secret': stringOption(),
    },
    run: async (input) => {
      const portStr = input.values['gateway-port']
      const gatewayPort = typeof portStr === 'string' ? Number.parseInt(portStr, 10) : undefined
      await agentSetup({
        agentProvider: getString(input.values, 'agent-provider'),
        agentKey: getString(input.values, 'agent-key'),
        agentModel: getString(input.values, 'agent-model'),
        gatewayPort,
        format: input.format,
        geminiKey: getString(input.values, 'gemini-key'),
        openaiKey: getString(input.values, 'openai-key'),
        claudeKey: getString(input.values, 'claude-key'),
        perplexityKey: getString(input.values, 'perplexity-key'),
        localUrl: getString(input.values, 'local-url'),
        localModel: getString(input.values, 'local-model'),
        localKey: getString(input.values, 'local-key'),
        googleClientId: getString(input.values, 'google-client-id'),
        googleClientSecret: getString(input.values, 'google-client-secret'),
      })
    },
  },
]
