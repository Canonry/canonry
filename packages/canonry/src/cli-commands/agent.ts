import { agentAttach, agentDetach } from '../commands/agent.js'
import { agentAsk } from '../commands/agent-ask.js'
import type { SupportedAgentProvider } from '../agent/session.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, stringOption } from '../cli-command-helpers.js'

const AGENT_PROVIDERS: readonly SupportedAgentProvider[] = ['anthropic', 'openai', 'google']

function coerceProvider(value: string | undefined): SupportedAgentProvider | undefined {
  if (!value) return undefined
  return (AGENT_PROVIDERS as readonly string[]).includes(value)
    ? (value as SupportedAgentProvider)
    : undefined
}

export const AGENT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['agent', 'ask'],
    usage: 'canonry agent ask <project> "<prompt>" [--provider anthropic|openai|google] [--model <id>] [--format json]',
    options: {
      provider: stringOption(),
      model: stringOption(),
    },
    run: async (input) => {
      const [project, ...rest] = input.positionals
      if (!project || rest.length === 0) {
        console.error('Usage: canonry agent ask <project> "<prompt>"')
        process.exitCode = 1
        return
      }
      const providerInput = getString(input.values, 'provider')
      if (providerInput && !coerceProvider(providerInput)) {
        console.error(`--provider must be one of: ${AGENT_PROVIDERS.join(', ')}`)
        process.exitCode = 1
        return
      }
      await agentAsk({
        project,
        prompt: rest.join(' '),
        provider: coerceProvider(providerInput),
        modelId: getString(input.values, 'model'),
        format: input.format,
      })
    },
  },
  {
    path: ['agent', 'attach'],
    usage: 'canonry agent attach <project> --url <webhook-url> [--format json]',
    options: {
      url: stringOption(),
    },
    run: async (input) => {
      const project = input.positionals[0]
      if (!project) {
        console.error('Usage: canonry agent attach <project> --url <webhook-url>')
        process.exitCode = 1
        return
      }
      const url = getString(input.values, 'url')
      if (!url) {
        console.error('Missing required --url flag. Specify the agent webhook URL to attach.')
        process.exitCode = 1
        return
      }
      await agentAttach({ project, url, format: input.format })
    },
  },
  {
    path: ['agent', 'detach'],
    usage: 'canonry agent detach <project> [--format json]',
    options: {},
    run: async (input) => {
      const project = input.positionals[0]
      if (!project) {
        console.error('Usage: canonry agent detach <project>')
        process.exitCode = 1
        return
      }
      await agentDetach({ project, format: input.format })
    },
  },
]
