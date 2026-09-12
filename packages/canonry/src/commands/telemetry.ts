import { configExists, getConfigPath } from '../config.js'
import { CliError, type CliFormat, isMachineFormat, usageError } from '../cli-error.js'
import { createApiClient } from '../client.js'
import { getTelemetryStatus, setTelemetryPreference } from '../telemetry.js'
import { normalizeTelemetryStatus, type TelemetryStatusDto, type TelemetryTarget } from '@ainyc/canonry-contracts'

type TelemetryPayload = TelemetryStatusDto & { configPath?: string; anonymousIdMasked?: string }

function telemetryTarget(value: string | undefined): TelemetryTarget {
  if (value === undefined || value === 'local') return 'local'
  if (value === 'server') return 'server'
  throw usageError('Error: --target must be "local" or "server"', {
    message: '--target must be "local" or "server"',
    details: { command: 'telemetry', target: value, allowed: ['local', 'server'] },
  })
}

function emitStatus(payload: TelemetryPayload, format: CliFormat, mutation = false): void {
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  const targetSuffix = payload.target === 'server' ? ' (server)' : ''
  if (mutation && payload.enabled === payload.configuredEnabled) {
    console.log(`Telemetry${targetSuffix} ${payload.enabled ? 'enabled.' : 'disabled. No data will be sent.'}`)
  } else if (payload.reason === 'CANONRY_TELEMETRY_DISABLED') {
    console.log(`Telemetry${targetSuffix}: disabled (CANONRY_TELEMETRY_DISABLED=1)`)
  } else if (payload.reason === 'DO_NOT_TRACK') {
    console.log(`Telemetry${targetSuffix}: disabled (DO_NOT_TRACK=1)`)
  } else if (payload.reason === 'CI') {
    console.log(`Telemetry${targetSuffix}: disabled (CI environment detected)`)
  } else if (payload.reason === 'NO_CONFIG') {
    console.log(`Telemetry${targetSuffix}: enabled (no config yet — run "canonry bootstrap" first)`)
  } else {
    console.log(`Telemetry${targetSuffix}: ${payload.enabled ? 'enabled' : 'disabled'}`)
  }
  if (payload.enabled !== payload.configuredEnabled) {
    console.log(`Configured telemetry: ${payload.configuredEnabled ? 'enabled' : 'disabled'}; effective state overridden by ${payload.reason}.`)
  }
  if (payload.anonymousId) console.log(`Anonymous ID: ${payload.anonymousId}`)
}

function localStatus(): TelemetryPayload {
  const status = getTelemetryStatus()
  return {
    ...status,
    ...(status.anonymousId ? { anonymousIdMasked: status.anonymousId } : {}),
    ...(configExists() ? { configPath: getConfigPath() } : {}),
  }
}

function requireLocalConfig(command: string): void {
  if (!configExists()) {
    throw new CliError({
      code: 'CONFIG_REQUIRED',
      message: 'No config found. Run "canonry bootstrap" first.',
      displayMessage: 'No config found. Run "canonry bootstrap" first.',
      details: { command },
    })
  }
}

async function serverTelemetryCommand(subcommand: 'status' | 'enable' | 'disable', format: CliFormat): Promise<void> {
  const client = createApiClient()
  const response = subcommand === 'status'
    ? await client.getTelemetry()
    : await client.updateTelemetry(subcommand === 'enable')
  emitStatus(normalizeTelemetryStatus(response), format, subcommand !== 'status')
}

export function telemetryCommand(
  subcommand?: string,
  format: CliFormat = 'text',
  targetValue?: string,
): void | Promise<void> {
  const available = ['status', 'enable', 'disable']
  const target = telemetryTarget(targetValue)

  if (target === 'server') {
    if (subcommand === 'status' || subcommand === 'enable' || subcommand === 'disable') {
      return serverTelemetryCommand(subcommand, format)
    }
  }

  switch (subcommand) {
    case 'status': {
      emitStatus(localStatus(), format)
      break
    }

    case 'enable': {
      requireLocalConfig('telemetry.enable')
      void setTelemetryPreference(true, 'cli')
      emitStatus(localStatus(), format, true)
      break
    }

    case 'disable': {
      requireLocalConfig('telemetry.disable')
      // Print the receipt immediately, then hold the process open until the
      // opt-out event is delivered (bounded by the 3s telemetry timeout).
      const delivery = setTelemetryPreference(false, 'cli')
      emitStatus(localStatus(), format, true)
      return delivery
    }

    default:
      throw usageError(`Error: unknown telemetry subcommand: ${subcommand ?? '(none)'}\nUsage: canonry telemetry <status|enable|disable> [--target local|server] [--format json]`, {
        message: `unknown telemetry subcommand: ${subcommand ?? '(none)'}`,
        details: {
          command: 'telemetry',
          usage: 'canonry telemetry <status|enable|disable> [--target local|server] [--format json]',
          available,
        },
      })
  }
}
