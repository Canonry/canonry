import { agentAttach, agentDetach } from '../commands/agent.js'
import { agentAsk, type AgentAskScope } from '../commands/agent-ask.js'
import { agentProviders } from '../commands/agent-providers.js'
import { agentTranscript, agentTranscriptReset } from '../commands/agent-transcript.js'
import {
  agentMemoryForget,
  agentMemoryList,
  agentMemorySet,
} from '../commands/agent-memory.js'
import { coerceAgentProvider, listAgentProviders } from '../agent/session.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, stringOption } from '../cli-command-helpers.js'
import { usageError } from '../cli-error.js'

const AGENT_ASK_SCOPES: readonly AgentAskScope[] = ['all', 'read-only']

export const AGENT_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['agent', 'ask'],
    usage: `canonry agent ask <project> "<prompt>" [--provider ${listAgentProviders().join('|')}] [--model <id>] [--scope all|read-only] [--format json]`,
    options: {
      provider: stringOption(),
      model: stringOption(),
      scope: stringOption(),
    },
    run: async (input) => {
      const [project, ...rest] = input.positionals
      if (!project || rest.length === 0) {
        console.error('Usage: canonry agent ask <project> "<prompt>"')
        process.exitCode = 1
        return
      }
      const providerInput = getString(input.values, 'provider')
      if (providerInput && !coerceAgentProvider(providerInput)) {
        console.error(`--provider must be one of: ${listAgentProviders().join(', ')}`)
        process.exitCode = 1
        return
      }
      const scopeInput = getString(input.values, 'scope')
      if (scopeInput && !AGENT_ASK_SCOPES.includes(scopeInput as AgentAskScope)) {
        console.error(`--scope must be one of: ${AGENT_ASK_SCOPES.join(', ')}`)
        process.exitCode = 1
        return
      }
      await agentAsk({
        project,
        prompt: rest.join(' '),
        provider: coerceAgentProvider(providerInput),
        modelId: getString(input.values, 'model'),
        scope: scopeInput as AgentAskScope | undefined,
        format: input.format,
      })
    },
  },
  {
    path: ['agent', 'providers'],
    usage: 'canonry agent providers <project> [--format json]',
    options: {},
    run: async (input) => {
      const project = input.positionals[0]
      if (!project) {
        console.error('Usage: canonry agent providers <project>')
        process.exitCode = 1
        return
      }
      await agentProviders({ project, format: input.format })
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
  {
    path: ['agent', 'transcript'],
    usage: 'canonry agent transcript <project> [--format json]',
    options: {},
    run: async (input) => {
      const project = input.positionals[0]
      if (!project) {
        console.error('Usage: canonry agent transcript <project>')
        process.exitCode = 1
        return
      }
      await agentTranscript({ project, format: input.format })
    },
  },
  {
    path: ['agent', 'reset'],
    usage: 'canonry agent reset <project> [--format json]',
    options: {},
    run: async (input) => {
      const project = input.positionals[0]
      if (!project) {
        console.error('Usage: canonry agent reset <project>')
        process.exitCode = 1
        return
      }
      await agentTranscriptReset({ project, format: input.format })
    },
  },
  {
    path: ['agent', 'memory', 'list'],
    usage: 'canonry agent memory list <project> [--format json]',
    options: {},
    run: async (input) => {
      const project = input.positionals[0]
      if (!project) {
        throw usageError('Usage: canonry agent memory list <project>', {
          message: 'project name is required',
        })
      }
      await agentMemoryList({ project, format: input.format })
    },
  },
  {
    path: ['agent', 'memory', 'set'],
    usage: 'canonry agent memory set <project> --key <k> --value <v> [--format json]',
    options: {
      key: stringOption(),
      value: stringOption(),
    },
    run: async (input) => {
      const project = input.positionals[0]
      if (!project) {
        throw usageError('Usage: canonry agent memory set <project> --key <k> --value <v>', {
          message: 'project name is required',
        })
      }
      const key = getString(input.values, 'key')
      const value = getString(input.values, 'value')
      if (!key || !value) {
        throw usageError('--key and --value are both required.', {
          message: '--key and --value are both required',
        })
      }
      await agentMemorySet({ project, key, value, format: input.format })
    },
  },
  {
    path: ['agent', 'memory', 'forget'],
    usage: 'canonry agent memory forget <project> --key <k> [--format json]',
    options: {
      key: stringOption(),
    },
    run: async (input) => {
      const project = input.positionals[0]
      if (!project) {
        throw usageError('Usage: canonry agent memory forget <project> --key <k>', {
          message: 'project name is required',
        })
      }
      const key = getString(input.values, 'key')
      if (!key) {
        throw usageError('--key is required.', {
          message: '--key is required',
        })
      }
      await agentMemoryForget({ project, key, format: input.format })
    },
  },
]
