import { AppError, parseWindowIn, resolveDateRange } from '@ainyc/canonry-contracts'
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

export interface WindowAliases {
  window?: string
  start?: string
  end?: string
}

/** Canonical flags and explicitly declared compatibility aliases only. */
export function windowOptions(config: { window?: boolean; dates?: boolean; aliases?: WindowAliases } = {}): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = {}
  if (config.window) options.window = stringOption()
  if (config.dates) { options.start = stringOption(); options.end = stringOption() }
  for (const alias of [config.aliases?.window, config.aliases?.start, config.aliases?.end]) {
    if (alias !== undefined) options[alias] = stringOption()
  }
  return options
}

export function readWindowOptions(input: CliCommandInput, config: { allowed?: readonly string[]; command: string; usage: string; aliases?: WindowAliases }): { window?: string; startDate?: string; endDate?: string } {
  const read = (canonical: 'window' | 'start' | 'end') => {
    const direct = getString(input.values, canonical)
    const alias = config.aliases?.[canonical]
    const old = alias ? getString(input.values, alias) : undefined
    if (direct !== undefined && old !== undefined) throw usageError(`Use either --${canonical} or --${alias}, not both.`, { details: { command: config.command, usage: config.usage } })
    return direct ?? old
  }
  const rawWindow = read('window')
  try {
    const window = rawWindow === undefined || rawWindow === '' ? undefined : parseWindowIn(rawWindow, config.allowed ?? [], { fallback: config.allowed?.[0] ?? '', field: 'window' })
    const startDate = read('start')
    const endDate = read('end')
    if (rawWindow !== undefined && (startDate !== undefined || endDate !== undefined)) throw usageError('Use --window or --start/--end, not both.')
    const dates = resolveDateRange({ startDate, endDate })
    return { window, startDate: dates.startDate ?? undefined, endDate: dates.endDate ?? undefined }
  } catch (error) {
    if (error instanceof AppError) throw usageError(error.message, { details: error.details })
    throw error
  }
}
