import { configExists, getConfigPath, loadConfig, saveConfigPatch } from '../config.js'
import { CliError, type CliFormat, isMachineFormat, usageError } from '../cli-error.js'
import { createApiClient } from '../client.js'
import {
  getTelemetryStatus,
  maskAnonymousId,
} from '../telemetry.js'
import { telemetryEffectiveReasonSchema, type TelemetryStatusDto, type TelemetryTarget } from '@ainyc/canonry-contracts'

type TelemetryStatusLike = Pick<TelemetryStatusDto, 'enabled'> & Partial<Omit<TelemetryStatusDto, 'enabled'>>
type TelemetryPayload = TelemetryStatusDto & { configPath?: string; anonymousIdMasked?: string }

function telemetryTarget(value: string | undefined): TelemetryTarget {
  if (value === undefined || value === 'local') return 'local'
  if (value === 'server') return 'server'
  throw usageError('Error: --target must be "local" or "server"', {
    message: '--target must be "local" or "server"',
    details: { command: 'telemetry', target: value, allowed: ['local', 'server'] },
  })
}

function statusFromServer(status: TelemetryStatusLike): TelemetryStatusDto {
  // New servers already mask this value; legacy servers may return a UUID.
  const anonymousId = maskAnonymousId(status.anonymousId)
  const reason = telemetryEffectiveReasonSchema.safeParse(status.reason)
  const knownReason = reason.success
    ? reason.data
    : status.enabled ? 'enabled' : 'configured_disabled'
  return {
    enabled: status.enabled,
    configuredEnabled: status.configuredEnabled ?? status.enabled,
    reason: knownReason,
    target: 'server',
    ...(anonymousId ? { anonymousId } : {}),
  }
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
  emitStatus(statusFromServer(response), format, subcommand !== 'status')
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
      const config = loadConfig()
      config.telemetry = true
      saveConfigPatch(config)
      emitStatus(localStatus(), format, true)
      break
    }

    case 'disable': {
      requireLocalConfig('telemetry.disable')
      const config = loadConfig()
      config.telemetry = false
      saveConfigPatch(config)
      emitStatus(localStatus(), format, true)
      break
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
