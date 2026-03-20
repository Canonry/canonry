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

export async function dispatchRegisteredCommand(
  args: readonly string[],
  fallbackFormat: CliFormat,
  specs: readonly CliCommandSpec[],
): Promise<boolean> {
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
