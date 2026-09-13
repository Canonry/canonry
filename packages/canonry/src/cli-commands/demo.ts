import type { CliCommandSpec } from '../cli-dispatch.js'
import { getString, getStringArray, multiStringOption, stringOption } from '../cli-command-helpers.js'
import { demoCommand } from '../commands/demo.js'

export const DEMO_CLI_COMMANDS: readonly CliCommandSpec[] = [{
  path: ['demo'],
  usage: 'canonry demo [--host <host>] [--port <port>] [--trust-proxy <ip-or-cidr>]... [--format json]',
  help: 'Serve a public, view-only dashboard with fresh fictional portfolios. No sign-in, existing configuration, provider credentials, live queries, or background jobs. Every restart recreates the in-memory sample. Default: 127.0.0.1:4188. API requests are rate limited per visitor address, which the demo takes from X-Forwarded-For only when a trusted proxy connects. Repeat --trust-proxy for each proxy address or CIDR range; the values replace the default of 127.0.0.1 and ::1.',
  options: { host: stringOption(), port: stringOption(), 'trust-proxy': multiStringOption() },
  allowPositionals: false,
  run: async input => {
    await demoCommand({
      host: getString(input.values, 'host'),
      port: getString(input.values, 'port'),
      trustProxy: getStringArray(input.values, 'trust-proxy'),
      format: input.format,
    })
  },
}]
