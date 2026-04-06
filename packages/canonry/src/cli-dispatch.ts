import { parseArgs } from 'node:util'
import type { ParseArgsOptionsConfig } from 'node:util'
import { type CliFormat, usageError } from './cli-error.js'

type CliValue = string | boolean | string[] | boolean[] | undefined

export type CliValues = Record<string, CliValue>

export type CliCommandInput = {
  positionals: string[]
  values: CliValues
  format: CliFormat
}

export type CliCommandSpec = {
  path: readonly string[]
  usage: string
  options?: ParseArgsOptionsConfig
  allowPositionals?: boolean
  run: (input: CliCommandInput) => Promise<void>
}

function commandId(spec: CliCommandSpec): string {
  return spec.path.join('.')
}

function matchesPath(args: readonly string[], path: readonly string[]): boolean {
  if (args.length < path.length) return false
  return path.every((segment, index) => args[index] === segment)
}

function withFormatOption(options?: ParseArgsOptionsConfig): ParseArgsOptionsConfig {
  if (!options) {
    return {
      format: { type: 'string' },
    }
  }

  if ('format' in options) return options
  return {
    ...options,
    format: { type: 'string' },
  }
}

function toFormat(value: CliValue, fallbackFormat: CliFormat): CliFormat {
  return value === 'json' ? 'json' : fallbackFormat
}

function printGroupHelp(group: string, specs: readonly CliCommandSpec[]): void {
  const parentSpec = specs.find(s => s.path.length === 1 && s.path[0] === group)
  const groupSpecs = specs
    .filter(s => s.path[0] === group && s.path.length > 1)
    .sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')))

  if (groupSpecs.length === 0) return

  console.log(`\nUsage:  canonry ${group} <command> [options]\n`)

  if (parentSpec) {
    console.log(`  ${parentSpec.usage}\n`)
  }

  console.log('Subcommands:')

  for (const spec of groupSpecs) {
    console.log(`  ${spec.usage}`)
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

    // Try longest-path match first so `canonry run show --help` shows the
    // specific subcommand usage, not the group help.
    const exactMatch = [...specs]
      .sort((a, b) => b.path.length - a.path.length)
      .find(candidate => matchesPath(argsWithoutHelp, candidate.path))

    if (exactMatch && exactMatch.path.length > 1) {
      // Specific subcommand — show its usage
      console.log(`\nUsage:  ${exactMatch.usage}\n`)
      return true
    }

    // Fall back to group help for `canonry <group> --help`
    const group = argsWithoutHelp[0]
    if (group) {
      const groupSpecs = specs.filter(s => s.path[0] === group && s.path.length > 1)
      if (groupSpecs.length > 0) {
        printGroupHelp(group, specs)
        return true
      }
      // Single command — show its usage string
      const single = specs.find(s => s.path.length === 1 && s.path[0] === group)
      if (single) {
        console.log(`\nUsage:  ${single.usage}\n`)
        return true
      }
    }
  }

  const spec = [...specs]
    .sort((a, b) => b.path.length - a.path.length)
    .find(candidate => matchesPath(args, candidate.path))

  if (!spec) return false

  const remainingArgs = args.slice(spec.path.length)
  let values: CliValues
  let positionals: string[]

  try {
    const parsed = parseArgs({
      args: remainingArgs,
      options: withFormatOption(spec.options),
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

  await spec.run({
    positionals,
    values,
    format: toFormat(values.format, fallbackFormat),
  })

  return true
}
