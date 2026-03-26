import { configExists, getConfigPath, loadConfig, saveConfigPatch } from '../config.js'
import { CliError, type CliFormat, usageError } from '../cli-error.js'

export function telemetryCommand(subcommand?: string, format: CliFormat = 'text'): void {
  const available = ['status', 'enable', 'disable']

  switch (subcommand) {
    case 'status': {
      const payload: {
        enabled: boolean
        reason?: string
        configPath?: string
        anonymousIdMasked?: string
      } = {
        enabled: true,
      }

      if (process.env.CANONRY_TELEMETRY_DISABLED === '1') {
        payload.enabled = false
        payload.reason = 'CANONRY_TELEMETRY_DISABLED'
        if (format === 'json') {
          console.log(JSON.stringify(payload, null, 2))
          return
        }
        console.log('Telemetry: disabled (CANONRY_TELEMETRY_DISABLED=1)')
        return
      }
      if (process.env.DO_NOT_TRACK === '1') {
        payload.enabled = false
        payload.reason = 'DO_NOT_TRACK'
        if (format === 'json') {
          console.log(JSON.stringify(payload, null, 2))
          return
        }
        console.log('Telemetry: disabled (DO_NOT_TRACK=1)')
        return
      }
      if (process.env.CI) {
        payload.enabled = false
        payload.reason = 'CI'
        if (format === 'json') {
          console.log(JSON.stringify(payload, null, 2))
          return
        }
        console.log('Telemetry: disabled (CI environment detected)')
        return
      }
      if (!configExists()) {
        payload.reason = 'NO_CONFIG'
        if (format === 'json') {
          console.log(JSON.stringify(payload, null, 2))
          return
        }
        console.log('Telemetry: enabled (no config yet — run "canonry init" first)')
        return
      }
      const config = loadConfig()
      payload.enabled = config.telemetry !== false
      payload.configPath = getConfigPath()
      if (config.anonymousId) {
        payload.anonymousIdMasked = config.anonymousId.slice(0, 8) + '...'
      }
      if (format === 'json') {
        console.log(JSON.stringify(payload, null, 2))
        return
      }

      const enabled = payload.enabled
      console.log(`Telemetry: ${enabled ? 'enabled' : 'disabled'}`)
      if (config.anonymousId) {
        const masked = config.anonymousId.slice(0, 8) + '...'
        console.log(`Anonymous ID: ${masked}`)
      }
      break
    }

    case 'enable': {
      if (!configExists()) {
        throw new CliError({
          code: 'CONFIG_REQUIRED',
          message: 'No config found. Run "canonry init" first.',
          displayMessage: 'No config found. Run "canonry init" first.',
          details: {
            command: 'telemetry.enable',
          },
        })
      }
      const config = loadConfig()
      config.telemetry = true
      saveConfigPatch(config)

      if (format === 'json') {
        console.log(JSON.stringify({
          enabled: true,
          configPath: getConfigPath(),
        }, null, 2))
        return
      }

      console.log('Telemetry enabled.')
      break
    }

    case 'disable': {
      if (!configExists()) {
        throw new CliError({
          code: 'CONFIG_REQUIRED',
          message: 'No config found. Run "canonry init" first.',
          displayMessage: 'No config found. Run "canonry init" first.',
          details: {
            command: 'telemetry.disable',
          },
        })
      }
      const config = loadConfig()
      config.telemetry = false
      saveConfigPatch(config)

      if (format === 'json') {
        console.log(JSON.stringify({
          enabled: false,
          configPath: getConfigPath(),
        }, null, 2))
        return
      }

      console.log('Telemetry disabled. No data will be sent.')
      break
    }

    default:
      throw usageError(`Error: unknown telemetry subcommand: ${subcommand ?? '(none)'}\nUsage: canonry telemetry <status|enable|disable> [--format json]`, {
        message: `unknown telemetry subcommand: ${subcommand ?? '(none)'}`,
        details: {
          command: 'telemetry',
          usage: 'canonry telemetry <status|enable|disable> [--format json]',
          available,
        },
      })
  }
}
