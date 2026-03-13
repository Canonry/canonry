import { loadConfig, saveConfig, configExists } from '../config.js'

export function telemetryCommand(subcommand?: string): void {
  switch (subcommand) {
    case 'status': {
      if (process.env.CANONRY_TELEMETRY_DISABLED === '1') {
        console.log('Telemetry: disabled (CANONRY_TELEMETRY_DISABLED=1)')
        return
      }
      if (process.env.DO_NOT_TRACK === '1') {
        console.log('Telemetry: disabled (DO_NOT_TRACK=1)')
        return
      }
      if (process.env.CI) {
        console.log('Telemetry: disabled (CI environment detected)')
        return
      }
      if (!configExists()) {
        console.log('Telemetry: enabled (no config yet — run "canonry init" first)')
        return
      }
      const config = loadConfig()
      const enabled = config.telemetry !== false
      console.log(`Telemetry: ${enabled ? 'enabled' : 'disabled'}`)
      if (config.anonymousId) {
        const masked = config.anonymousId.slice(0, 8) + '...'
        console.log(`Anonymous ID: ${masked}`)
      }
      break
    }

    case 'enable': {
      if (!configExists()) {
        console.error('No config found. Run "canonry init" first.')
        process.exit(1)
      }
      const config = loadConfig()
      config.telemetry = true
      saveConfig(config)
      console.log('Telemetry enabled.')
      break
    }

    case 'disable': {
      if (!configExists()) {
        console.error('No config found. Run "canonry init" first.')
        process.exit(1)
      }
      const config = loadConfig()
      config.telemetry = false
      saveConfig(config)
      console.log('Telemetry disabled. No data will be sent.')
      break
    }

    default:
      console.error(`Unknown telemetry subcommand: ${subcommand ?? '(none)'}`)
      console.log('Available: status, enable, disable')
      process.exit(1)
  }
}
