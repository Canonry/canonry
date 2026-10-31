import { readWindowOptions, windowOptions, type WindowAliases } from './cli-command-helpers.js'
import { parseArgs } from 'node:util'
import type { ParseArgsOptionsConfig } from 'node:util'
import { OperationAccesses, type OperationAccess } from '@canonry/canonry-contracts'
import { CliError, EXIT_USER_ERROR, type CliFormat, usageError } from './cli-error.js'
import { resolveCliAccessForInvocation } from './cli-access.js'

type CliValue = string | boolean | string[] | boolean[] | undefined

export type CliValues = Record<string, CliValue>

export type CliCommandInput = {
  positionals: string[]
  values: CliValues
  format: CliFormat
  /**
   * True when the user passed `--dry-run`. Only set to `true` for commands
   * that opt in via `CliCommandSpec.supportsDryRun`; for commands that don't,
   * passing `--dry-run` raises a usage error before `run` is invoked, so a
   * command author who reads `input.dryRun` can trust it.
   */
  dryRun: boolean
}

export type CliAccessContext = Pick<CliCommandInput, 'positionals' | 'values' | 'dryRun'>

export type CliCommandSpec = {
  path: readonly string[]
  usage: string
  /** Optional prose shown after usage for contextual `--help` requests. */
  help?: string
  options?: ParseArgsOptionsConfig
  allowPositionals?: boolean
  /**
   * Whether `--dry-run` is meaningful for this command. The dispatcher rejects
   * `--dry-run` on commands that don't opt in, so agents can rely on the
   * preview semantics actually being implemented (rather than silently
   * ignored, which would risk writes when the agent thought it was previewing).
   */
  supportsDryRun?: boolean
  /** Canonical rolling windows and legacy option names accepted by this command. */
  windows?: readonly string[]
  windowAliases?: WindowAliases
  /** Execution boundary shown in help and the generated catalog. */
  access?: OperationAccess
  /** Resolve access for flags that change a command from a write to a stored preview. */
  accessFor?: (input: CliAccessContext) => OperationAccess
  run: (input: CliCommandInput) => Promise<void> | void
}

function commandId(spec: CliCommandSpec): string {
  return spec.path.join('.')
}

export function commandUsage(spec: CliCommandSpec): string {
  let usage = spec.usage
  if (spec.windows) {
    const selection = `[--window ${spec.windows.join('|')}]`
    if (usage.includes('[--window ')) usage = usage.replace(/\[--window [^\]]+\]/, selection)
    else if (spec.windowAliases?.window === 'period') usage = usage.replace(/\[--period [^\]]+\]/, selection)
    else usage += ` ${selection}`
  }
  for (const key of ['start', 'end'] as const) {
    const alias = spec.windowAliases?.[key]
    if (alias) usage = usage.replace(`--${alias} `, `--${key} `)
  }
  return usage
}

function printCommandHelp(spec: CliCommandSpec): void {
  console.log(`\nUsage:  ${commandUsage(spec)}\n`)
  const access = spec.access ?? OperationAccesses.stored
  console.log(`Access: ${access} (${access === OperationAccesses.live ? 'calls a provider now' : access === OperationAccesses.write ? 'changes server state' : 'uses stored data'})\n`)
  if (spec.help) console.log(`${spec.help}\n`)
  const aliases = Object.entries(spec.windowAliases ?? {}).map(([canonical, alias]) => `--${alias} for --${canonical}`)
  if (aliases.length) console.log(`Aliases: ${aliases.join('; ')}. Do not combine an alias with its canonical flag.\n`)
}

function matchesPath(args: readonly string[], path: readonly string[]): boolean {
  if (args.length < path.length) return false
  return path.every((segment, index) => args[index] === segment)
}

export const CLI_GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  format: { type: 'string' },
  'dry-run': { type: 'boolean' },
  trace: { type: 'boolean' },
  access: { type: 'string' },
  'stored-only': { type: 'boolean' },
}

export function commandOptions(spec: CliCommandSpec): ParseArgsOptionsConfig {
  return { ...CLI_GLOBAL_OPTIONS, ...spec.options, ...windowOptions({ window: Boolean(spec.windows), dates: Boolean(spec.options?.start || spec.windowAliases?.start), aliases: spec.windowAliases }) }
}

export function accessFilterFromArgs(args: readonly string[]): string | undefined {
  const index = args.findIndex(arg => arg === '--access' || arg.startsWith('--access='))
  if (index < 0) return undefined
  const arg = args[index]!
  const value = arg.startsWith('--access=') ? arg.slice('--access='.length) : args[index + 1]
  if (!value || value.startsWith('--')) throw usageError('--access requires stored, live, or write', { details: { option: 'access' } })
  return value
}

function validateAccessFilter(value: string | undefined): asserts value is OperationAccess | undefined {
  if (value !== undefined && value !== OperationAccesses.stored && value !== OperationAccesses.live && value !== OperationAccesses.write) {
    throw usageError(`Unknown access filter: ${value}`, { details: { access: value } })
  }
}

function toFormat(value: CliValue, fallbackFormat: CliFormat): CliFormat {
  if (value === 'json') return 'json'
  if (value === 'jsonl') return 'jsonl'
  return fallbackFormat
}

export function printGroupHelp(group: string, specs: readonly CliCommandSpec[], accessFilter?: OperationAccess): void {
  const parentSpec = specs.find(s => s.path.length === 1 && s.path[0] === group)
  const groupSpecs = specs
    .filter(s => s.path[0] === group && s.path.length > 1 && (!accessFilter || (s.access ?? OperationAccesses.stored) === accessFilter))
    .sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')))

  if (groupSpecs.length === 0) {
    if (parentSpec && (!accessFilter || (parentSpec.access ?? OperationAccesses.stored) === accessFilter)) printCommandHelp(parentSpec)
    else if (accessFilter) console.log(`No commands in group "${group}" match access "${accessFilter}".`)
    return
  }

  console.log(`\nUsage:  canonry ${group} <command> [options]\n`)

  if (parentSpec && (!accessFilter || (parentSpec.access ?? OperationAccesses.stored) === accessFilter)) {
    const access = parentSpec.access ?? OperationAccesses.stored
    console.log(`  [${access}] ${commandUsage(parentSpec)}\n`)
  }

  console.log('Subcommands:')

  for (const spec of groupSpecs) {
    console.log(`  [${spec.access ?? OperationAccesses.stored}] ${commandUsage(spec)}`)
  }

  console.log()
}

export async function dispatchRegisteredCommand(
  args: readonly string[],
  fallbackFormat: CliFormat,
  specs: readonly CliCommandSpec[],
): Promise<boolean> {
  // Handle `canonry <command> --help` — show contextual help
  if (args.length >= 1 && (args.includes('--help') || args.includes('-h'))) {
    // Strip --help/-h from args for path matching
    const argsWithoutHelp = args.filter(a => a !== '--help' && a !== '-h')
    const accessValue = accessFilterFromArgs(argsWithoutHelp)
    validateAccessFilter(accessValue)

    if (fallbackFormat !== 'text') {
      const { printCliCatalog } = await import('./cli-catalog.js')
      const group = argsWithoutHelp.find(arg => !arg.startsWith('--'))
      printCliCatalog(specs, fallbackFormat, group, accessValue)
      return true
    }

    // Try longest-path match first so `canonry run show --help` shows the
    // specific subcommand usage, not the group help.
    const exactMatch = [...specs]
      .sort((a, b) => b.path.length - a.path.length)
      .find(candidate => matchesPath(argsWithoutHelp, candidate.path))

    if (exactMatch && exactMatch.path.length > 1) {
      // Specific subcommand — show its usage
      if (accessValue !== undefined && (exactMatch.access ?? OperationAccesses.stored) !== accessValue) {
        console.log(`No command "${exactMatch.path.join(' ')}" matches access "${accessValue}".`)
      } else {
        printCommandHelp(exactMatch)
      }
      return true
    }

    // Fall back to group help for `canonry <group> --help`
    const group = argsWithoutHelp[0]
    if (group) {
      const groupSpecs = specs.filter(s => s.path[0] === group && s.path.length > 1)
      if (groupSpecs.length > 0) {
        printGroupHelp(group, specs, accessValue)
        return true
      }
      // Single command — show its usage string
      const single = specs.find(s => s.path.length === 1 && s.path[0] === group)
      if (single) {
        printGroupHelp(group, specs, accessValue)
        return true
      }
    }
  }

  const spec = [...specs]
    .sort((a, b) => b.path.length - a.path.length)
    .find(candidate => matchesPath(args, candidate.path))

  if (!spec) {
    const root = args[0]
    if (root && specs.some(candidate => candidate.path[0] === root)) {
      if (args.length === 1) {
        printGroupHelp(root, specs)
        return true
      }
      throw usageError(`Error: unknown ${root} subcommand: ${args[1]}`, {
        message: `unknown ${root} subcommand`,
        details: { command: root, subcommand: args[1] },
      })
    }
    return false
  }

  const remainingArgs = args.slice(spec.path.length)
  let values: CliValues
  let positionals: string[]

  try {
    const parsed = parseArgs({
      args: remainingArgs,
      options: commandOptions(spec),
      allowPositionals: spec.allowPositionals ?? true,
    })
    values = parsed.values as CliValues
    positionals = [...parsed.positionals]
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid command usage'
    throw usageError(`Error: ${message}\nUsage: ${spec.usage}`, {
      message,
      details: {
        command: commandId(spec),
        usage: spec.usage,
      },
    })
  }

  if (values.access !== undefined && spec.path[0] !== 'help') {
    throw usageError('--access is supported only with help or --help', {
      message: '--access is supported only with help or --help',
      details: { command: commandId(spec), usage: commandUsage(spec) },
    })
  }

  // Flip CANONRY_TRACE on for the rest of this process when --trace was
  // passed. The ApiClient reads the env var to gate its stderr trace
  // output — env var avoids threading a "trace" plumb through every
  // existing command handler.
  if (values.trace === true) {
    process.env.CANONRY_TRACE = '1'
  }

  const dryRunRequested = values['dry-run'] === true
  const access = resolveCliAccessForInvocation(spec, { positionals, values, dryRun: dryRunRequested })
  const storedOnly = values['stored-only'] === true || ['1', 'true'].includes((process.env.CANONRY_STORED_ONLY ?? '').toLowerCase())
  if (storedOnly) {
    process.env.CANONRY_STORED_ONLY = '1'
    if (access !== OperationAccesses.stored) {
      throw new CliError({
        code: 'STORED_ONLY_REFUSED',
        message: `Command "${spec.path.join(' ')}" is ${access}; --stored-only allows saved-data reads only`,
        details: { command: commandId(spec), access },
        exitCode: EXIT_USER_ERROR,
      })
    }
  }

  if (dryRunRequested && !spec.supportsDryRun) {
    throw usageError(
      `Command "${spec.path.join(' ')}" does not support --dry-run. Either drop the flag, or run a different command that supports preview mode (e.g. ` +
      `\`canonry doctor\` for health checks, \`canonry status <project>\` for read-only state).`,
      {
        message: `Command "${spec.path.join(' ')}" does not support --dry-run`,
        details: { command: commandId(spec), usage: spec.usage },
      },
    )
  }

  if (spec.windows || spec.windowAliases) {
    const selection = readWindowOptions({ positionals, values, format: toFormat(values.format, fallbackFormat), dryRun: dryRunRequested }, { allowed: spec.windows, aliases: spec.windowAliases, command: commandId(spec), usage: commandUsage(spec) })
    values.window = selection.window
    values.start = selection.startDate
    values.end = selection.endDate
  }

  await spec.run({
    positionals,
    values,
    format: toFormat(values.format, fallbackFormat),
    dryRun: dryRunRequested,
  })

  return true
}
