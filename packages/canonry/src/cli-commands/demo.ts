import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, stringOption } from '../cli-command-helpers.js'
import { demoCommand } from '../commands/demo.js'

export const DEMO_CLI_COMMANDS: readonly CliCommandSpec[] = [{
  path: ['demo'],
  usage: 'canonry demo [--host <host>] [--port <port>] [--format json]',
  help: 'Serve a public, view-only dashboard with fresh fictional portfolios. No sign-in, existing configuration, provider credentials, live queries, or background jobs. Every restart recreates the in-memory sample. Default: 127.0.0.1:4188.',
  options: { host: stringOption(), port: stringOption() },
  allowPositionals: false,
  run: async input => { await demoCommand({ host: getString(input.values, 'host'), port: getString(input.values, 'port'), format: input.format }) },
}]
