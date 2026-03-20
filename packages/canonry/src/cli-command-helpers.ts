import type { ParseArgsOptionsConfig } from 'node:util'
import type { CliCommandInput, CliValues } from './cli-dispatch.js'
import { usageError } from './cli-error.js'

export function getString(values: CliValues, key: string): string | undefined {
  const value = values[key]
  return typeof value === 'string' ? value : undefined
}

export function getBoolean(values: CliValues, key: string): boolean {
  return values[key] === true
}

export function getStringArray(values: CliValues, key: string): string[] | undefined {
  const value = values[key]
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }
  return undefined
}

export function requirePositional(
  input: CliCommandInput,
  index: number,
  config: { message: string; usage: string; command: string },
): string {
  const value = input.positionals[index]
  if (value) return value
  throw usageError(`Error: ${config.message}\nUsage: ${config.usage}`, {
    message: config.message,
    details: {
      command: config.command,
      usage: config.usage,
    },
  })
}

export function requireProject(
  input: CliCommandInput,
  command: string,
  usage: string,
  message = 'project name is required',
): string {
  return requirePositional(input, 0, { command, usage, message })
}

export function stringOption(): ParseArgsOptionsConfig[string] {
  return { type: 'string' }
}

export function multiStringOption(): ParseArgsOptionsConfig[string] {
  return { type: 'string', multiple: true }
}

export function requireStringOption(
  input: CliCommandInput,
  key: string,
  config: { message: string; usage: string; command: string; details?: Record<string, unknown> },
): string {
  const value = getString(input.values, key)
  if (value) return value
  throw usageError(`Error: ${config.message}\nUsage: ${config.usage}`, {
    message: config.message,
    details: {
      command: config.command,
      usage: config.usage,
      ...(config.details ?? {}),
    },
  })
}

export function parseIntegerOption(
  input: CliCommandInput,
  key: string,
  config: { message: string; usage: string; command: string },
): number | undefined {
  const value = getString(input.values, key)
  if (!value) return undefined

  const parsed = Number.parseInt(value, 10)
  if (!Number.isNaN(parsed)) {
    return parsed
  }

  throw usageError(`Error: ${config.message}\nUsage: ${config.usage}`, {
    message: config.message,
    details: {
      command: config.command,
      usage: config.usage,
      option: key,
      value,
    },
  })
}

export function unknownSubcommand(
  subcommand: string | undefined,
  config: { command: string; usage: string; available: string[] },
): never {
  const resolved = subcommand ?? '(none)'
  throw usageError(`Error: unknown ${config.command} subcommand: ${resolved}\nUsage: ${config.usage}`, {
    message: `unknown ${config.command} subcommand: ${resolved}`,
    details: {
      command: config.command,
      usage: config.usage,
      available: config.available,
    },
  })
}
