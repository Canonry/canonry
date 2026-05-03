import { emitInstallSummary, installSkills, listSkills, parseSkillsClient } from '../commands/skills.js'
import type { CliCommandSpec } from '../cli-dispatch.js'
import { getBoolean, getString, stringOption, unknownSubcommand } from '../cli-command-helpers.js'

export const SKILLS_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['skills', 'list'],
    usage: 'canonry skills list [--format json]',
    run: async (input) => {
      await listSkills({ format: input.format })
    },
  },
  {
    path: ['skills', 'install'],
    usage: 'canonry skills install [skill...] [--dir <path>] [--client claude|codex|all] [--force] [--format json]',
    options: {
      dir: stringOption(),
      client: stringOption(),
      force: { type: 'boolean' },
    },
    allowPositionals: true,
    run: async (input) => {
      const summary = await installSkills({
        dir: getString(input.values, 'dir'),
        skills: input.positionals.length > 0 ? input.positionals : undefined,
        client: parseSkillsClient(getString(input.values, 'client')),
        force: getBoolean(input.values, 'force'),
      })
      emitInstallSummary(summary, input.format)
    },
  },
  {
    path: ['skills'],
    usage: 'canonry skills <list|install> [args]',
    run: async (input) => {
      unknownSubcommand(input.positionals[0], {
        command: 'skills',
        usage: 'canonry skills <list|install> [args]',
        available: ['list', 'install'],
      })
    },
  },
]
