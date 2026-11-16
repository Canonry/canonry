import { agentBrowserAgentSchema } from '@canonry/canonry-contracts'
import type { AgentBrowserAgent, AgentBrowserCheckRequest } from '@canonry/canonry-contracts'
import { usageError } from '../cli-error.js'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  getStringArray,
  multiStringOption,
  parseIntegerOption,
  requireProject,
  requireStringOption,
  stringOption,
} from '../cli-command-helpers.js'

const CHECK_USAGE =
  'canonry agent-browser check <project> --task <text> [--property <key>] [--start-url <url>] [--agent <openai|claude|gemini|claude-a11y>...] [--model <agent>=<model>...] [--runs <n>] [--expect-url <path>] [--expect-answer <phrase>...] [--expect-submit <path>] [--expect-field <name>=<value>...] [--max-minutes <n>] [--max-turns <n>] [--wait] [--format json]'
const CHECKS_USAGE = 'canonry agent-browser checks <project> [--property <key>] [--limit <n>] [--format json|jsonl]'
const SHOW_USAGE = 'canonry agent-browser show <project> --run-id <id> [--format json|jsonl]'

function pairs(input: CliCommandInput, key: string, command: string, usage: string): Array<[string, string]> {
  return (getStringArray(input.values, key) ?? []).map((raw) => {
    const at = raw.indexOf('=')
    if (at <= 0) {
      throw usageError(`Error: --${key} takes <name>=<value>, got "${raw}"\nUsage: ${usage}`, {
        message: `--${key} takes <name>=<value>`,
        details: { command, usage, option: key, value: raw },
      })
    }
    return [raw.slice(0, at).trim(), raw.slice(at + 1)]
  })
}

function parseAgent(value: string, usage: string): AgentBrowserAgent {
  const parsed = agentBrowserAgentSchema.safeParse(value.trim())
  if (!parsed.success) {
    throw usageError(`Error: unknown agent "${value}". Use ${agentBrowserAgentSchema.options.join(', ')}.\nUsage: ${usage}`, {
      message: `unknown agent "${value}"`,
      details: { command: 'agent-browser.check', usage, option: 'agent', value, allowed: agentBrowserAgentSchema.options },
    })
  }
  return parsed.data
}

/** Builds the API request from flags; the API applies the remaining defaults. */
export function agentBrowserRequestFromInput(input: CliCommandInput): AgentBrowserCheckRequest {
  const command = 'agent-browser.check'
  const task = requireStringOption(input, 'task', { command, usage: CHECK_USAGE, message: '--task is required: say what the agents should do' })
  const agents = (getStringArray(input.values, 'agent') ?? []).flatMap((v) => v.split(',')).filter(Boolean).map((v) => parseAgent(v, CHECK_USAGE))
  const models = Object.fromEntries(pairs(input, 'model', command, CHECK_USAGE).map(([agent, model]) => [parseAgent(agent, CHECK_USAGE), model]))
  const fields = Object.fromEntries(pairs(input, 'expect-field', command, CHECK_USAGE))
  const expectUrl = getString(input.values, 'expect-url')
  const expectSubmit = getString(input.values, 'expect-submit')
  const answers = getStringArray(input.values, 'expect-answer') ?? []
  if (Object.keys(fields).length && !expectSubmit) {
    throw usageError(`Error: --expect-field needs --expect-submit <path>\nUsage: ${CHECK_USAGE}`, {
      message: '--expect-field needs --expect-submit',
      details: { command, usage: CHECK_USAGE },
    })
  }
  const expect = {
    ...(expectUrl ? { urlPath: expectUrl } : {}),
    ...(answers.length ? { answerIncludes: answers } : {}),
    ...(expectSubmit ? { submitPath: expectSubmit } : {}),
    ...(Object.keys(fields).length ? { submitFields: fields } : {}),
  }
  const startUrl = getString(input.values, 'start-url')
  const property = getString(input.values, 'property')?.trim()
  const repeats = parseIntegerOption(input, 'runs', { command, usage: CHECK_USAGE, message: '--runs must be an integer' })
  const maxMinutesPerRun = parseIntegerOption(input, 'max-minutes', { command, usage: CHECK_USAGE, message: '--max-minutes must be an integer' })
  const maxTurnsPerRun = parseIntegerOption(input, 'max-turns', { command, usage: CHECK_USAGE, message: '--max-turns must be an integer' })
  return {
    task,
    ...(property ? { property } : {}),
    ...(startUrl ? { startUrl } : {}),
    ...(agents.length ? { agents } : {}),
    ...(Object.keys(models).length ? { models } : {}),
    ...(repeats !== undefined ? { repeats } : {}),
    ...(Object.keys(expect).length ? { expect } : {}),
    ...(maxMinutesPerRun !== undefined ? { maxMinutesPerRun } : {}),
    ...(maxTurnsPerRun !== undefined ? { maxTurnsPerRun } : {}),
  }
}

export const AGENT_BROWSER_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    path: ['agent-browser', 'check'],
    usage: CHECK_USAGE,
    help:
      'Start an agent-browser check: AI agents try the task on the project\'s site in a real browser, each in its own isolated page. openai, claude and gemini work from screenshots; claude-a11y is Claude reading the accessibility tree. Defaults: openai, claude and claude-a11y, one run each, from the project\'s home page. In an Advanced Measurement portfolio, --property <key> checks one Property: its URLs in the published plan count as the site (with the project\'s), and agents start on its most specific page. Every run spends on your provider accounts. The browser never lets data out: a form submission to the site is answered locally and recorded, other sites are blocked, analytics are dropped. Canonry decides pass/fail from --expect-url (the page the run ends on), --expect-answer (phrases the answer must contain) and --expect-submit with --expect-field (a caught form submission and its values); with no expectation a pass is unverified. Needs a local Chrome or Chromium (or CANONRY_CHROME_PATH): every agent run launches its own, behind a proxy that dials only public addresses, with WebSockets and service workers off and new tabs opened in the same page. A provider safety prompt (an action that needs a person\'s confirmation) stops the run there. --wait polls until the check finishes and exits 2 when it failed (no agent run could be judged); a check whose agents failed the task still exits 0.',
    options: {
      task: stringOption(),
      property: stringOption(),
      'start-url': stringOption(),
      agent: multiStringOption(),
      model: multiStringOption(),
      runs: stringOption(),
      'expect-url': stringOption(),
      'expect-answer': multiStringOption(),
      'expect-submit': stringOption(),
      'expect-field': multiStringOption(),
      'max-minutes': stringOption(),
      'max-turns': stringOption(),
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const { agentBrowserCheck } = await import('../commands/agent-browser.js')
      const project = requireProject(input, 'agent-browser.check', CHECK_USAGE)
      await agentBrowserCheck(project, { request: agentBrowserRequestFromInput(input), wait: getBoolean(input.values, 'wait'), format: input.format })
    },
  },
  {
    path: ['agent-browser', 'checks'],
    usage: CHECKS_USAGE,
    help: 'List the project\'s agent-browser checks, newest first, with their Property, task, agents and result counts. --property <key> keeps one Property\'s checks. Reads stored results only.',
    options: { limit: stringOption(), property: stringOption() },
    run: async (input) => {
      const { agentBrowserChecks } = await import('../commands/agent-browser.js')
      const project = requireProject(input, 'agent-browser.checks', CHECKS_USAGE)
      const limit = parseIntegerOption(input, 'limit', { command: 'agent-browser.checks', usage: CHECKS_USAGE, message: '--limit must be an integer' })
      await agentBrowserChecks(project, { limit, property: getString(input.values, 'property')?.trim() || undefined, format: input.format })
    },
  },
  {
    path: ['agent-browser', 'show'],
    usage: SHOW_USAGE,
    help: 'Show one agent-browser check: each agent run\'s status, what Canonry verified, its answer, effort and the submissions the browser caught. Reads stored results only.',
    options: { 'run-id': stringOption() },
    run: async (input) => {
      const { agentBrowserShow } = await import('../commands/agent-browser.js')
      const project = requireProject(input, 'agent-browser.show', SHOW_USAGE)
      const runId = requireStringOption(input, 'run-id', { command: 'agent-browser.show', usage: SHOW_USAGE, message: '--run-id is required' })
      await agentBrowserShow(project, runId, { format: input.format })
    },
  },
]
