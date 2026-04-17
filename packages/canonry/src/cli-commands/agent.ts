import { agentAttach, agentDetach } from '../commands/agent.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, stringOption } from '../cli-command-helpers.js'

export const AGENT_CLI_COMMANDS: readonly CliCommandSpec[] = [
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
