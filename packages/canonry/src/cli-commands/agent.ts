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
import { getString, requireProject, requireStringOption, stringOption } from '../cli-command-helpers.js'
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
      const usage = `canonry agent ask <project> "<prompt>" [--provider ${listAgentProviders().join('|')}] [--model <id>] [--scope all|read-only] [--format json]`
      const project = requireProject(input, 'agent.ask', usage)
      const prompt = input.positionals.slice(1).join(' ').trim()
      if (!prompt) {
        throw usageError(`Error: prompt is required\nUsage: ${usage}`, {
          message: 'prompt is required',
          details: {
            command: 'agent.ask',
            usage,
          },
        })
      }
      const providerInput = getString(input.values, 'provider')
      if (providerInput && !coerceAgentProvider(providerInput)) {
        throw usageError(`Error: --provider must be one of: ${listAgentProviders().join(', ')}\nUsage: ${usage}`, {
          message: `--provider must be one of: ${listAgentProviders().join(', ')}`,
          details: {
            command: 'agent.ask',
            usage,
            provider: providerInput,
            validProviders: listAgentProviders(),
          },
        })
      }
      const scopeInput = getString(input.values, 'scope')
      if (scopeInput && !AGENT_ASK_SCOPES.includes(scopeInput as AgentAskScope)) {
        throw usageError(`Error: --scope must be one of: ${AGENT_ASK_SCOPES.join(', ')}\nUsage: ${usage}`, {
          message: `--scope must be one of: ${AGENT_ASK_SCOPES.join(', ')}`,
          details: {
            command: 'agent.ask',
            usage,
            scope: scopeInput,
            validScopes: AGENT_ASK_SCOPES,
          },
        })
      }
      await agentAsk({
        project,
        prompt,
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
      const project = requireProject(input, 'agent.providers', 'canonry agent providers <project> [--format json]')
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
      const usage = 'canonry agent attach <project> --url <webhook-url> [--format json]'
      const project = requireProject(input, 'agent.attach', usage)
      const url = requireStringOption(input, 'url', {
        command: 'agent.attach',
        usage,
        message: '--url is required',
        details: {
          flag: 'url',
        },
      })
      await agentAttach({ project, url, format: input.format })
    },
  },
  {
    path: ['agent', 'detach'],
    usage: 'canonry agent detach <project> [--format json]',
    options: {},
    run: async (input) => {
      const project = requireProject(input, 'agent.detach', 'canonry agent detach <project> [--format json]')
      await agentDetach({ project, format: input.format })
    },
  },
  {
    path: ['agent', 'transcript'],
    usage: 'canonry agent transcript <project> [--format json]',
    options: {},
    run: async (input) => {
      const project = requireProject(input, 'agent.transcript', 'canonry agent transcript <project> [--format json]')
      await agentTranscript({ project, format: input.format })
    },
  },
  {
    path: ['agent', 'reset'],
    usage: 'canonry agent reset <project> [--format json]',
    options: {},
    run: async (input) => {
      const project = requireProject(input, 'agent.reset', 'canonry agent reset <project> [--format json]')
      await agentTranscriptReset({ project, format: input.format })
    },
  },
  {
    path: ['agent', 'clear'],
    usage: 'canonry agent clear <project> [--format json]',
    options: {},
    run: async (input) => {
      const project = requireProject(input, 'agent.clear', 'canonry agent clear <project> [--format json]')
      await agentTranscriptReset({ project, format: input.format })
    },
  },
  {
    path: ['agent', 'memory', 'list'],
    usage: 'canonry agent memory list <project> [--format json]',
    options: {},
    run: async (input) => {
      const usage = 'canonry agent memory list <project> [--format json]'
      const project = requireProject(input, 'agent.memory.list', usage)
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
      const usage = 'canonry agent memory set <project> --key <k> --value <v> [--format json]'
      const project = requireProject(input, 'agent.memory.set', usage)
      const key = requireStringOption(input, 'key', {
        command: 'agent.memory.set',
        usage,
        message: '--key is required',
        details: {
          flag: 'key',
        },
      })
      const value = requireStringOption(input, 'value', {
        command: 'agent.memory.set',
        usage,
        message: '--value is required',
        details: {
          flag: 'value',
        },
      })
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
      const usage = 'canonry agent memory forget <project> --key <k> [--format json]'
      const project = requireProject(input, 'agent.memory.forget', usage)
      const key = requireStringOption(input, 'key', {
        command: 'agent.memory.forget',
        usage,
        message: '--key is required',
        details: {
          flag: 'key',
        },
      })
      await agentMemoryForget({ project, key, format: input.format })
    },
  },
]
