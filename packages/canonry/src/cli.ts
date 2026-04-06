#!/usr/bin/env node --import tsx
import { pathToFileURL } from 'node:url'
import { trackEvent, isTelemetryEnabled, isFirstRun, getOrCreateAnonymousId, showFirstRunNotice } from './telemetry.js'
import { CliError, EXIT_SYSTEM_ERROR, EXIT_USER_ERROR, printCliError, usageError } from './cli-error.js'
import { dispatchRegisteredCommand } from './cli-dispatch.js'
import { REGISTERED_CLI_COMMANDS } from './cli-commands.js'

const USAGE = `
canonry — AEO monitoring CLI

Usage:  canonry <command> [options]

Setup:
  init                  Initialize config and database
  bootstrap             Bootstrap config/database from env vars
  serve                 Start the local server (foreground)
  start / stop          Start/stop as a background daemon

Projects:
  project               Create, update, list, show, delete projects
  keyword               Add, remove, list, import, generate key phrases
  competitor            Add, list competitors

Monitoring:
  run                   Trigger visibility sweeps
  snapshot              One-shot AI perception report
  status <project>      Show project summary
  evidence <project>    Show per-phrase results
  analytics <project>   Show analytics (metrics, gaps, sources)
  insights <project>    Show intelligence insights
  health <project>      Show citation health

Config-as-Code:
  apply <file...>       Apply declarative config (YAML)
  export <project>      Export project as YAML

Integrations:
  google                Google Search Console / Analytics
  bing                  Bing Webmaster Tools
  wordpress             WordPress REST API

Automation:
  schedule              Manage scheduled runs
  notify                Manage webhook notifications

Admin:
  settings              Show/update provider and quota settings
  backfill              Backfill answer visibility or insights
  telemetry             Manage anonymous telemetry
  history <project>     Show audit trail

Global options:
  --format json         Machine-readable output (all commands)
  --help, -h            Show help (use with any command group)
  --version, -v         Show version

Run 'canonry <command> --help' for details on a specific command.
`.trim()

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { version: VERSION } = _require('../package.json') as { version: string }

/** Extract --format flag from args. Returns 'json' or 'text' (default). */
function extractFormat(cmdArgs: string[]): 'text' | 'json' {
  const idx = cmdArgs.indexOf('--format')
  if (idx !== -1 && cmdArgs[idx + 1] === 'json') return 'json'
  return 'text'
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE)
    return 0
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION)
    return 0
  }

  const command = args[0]!
  const format = extractFormat(args)

  // First-run telemetry notice (shown once, to stderr).
  // Skip for the `telemetry` command itself — the user may be about to disable it,
  // and we should not create an anonymousId before they get the chance to opt out.
  if (command !== 'telemetry' && command !== 'init' && isTelemetryEnabled() && isFirstRun()) {
    showFirstRunNotice()
    getOrCreateAnonymousId()
  }

  // Resolve command name for telemetry (e.g. "project.create", "run")
  const SUBCOMMAND_COMMANDS = new Set(['backfill', 'project', 'keyword', 'competitor', 'schedule', 'notify', 'settings', 'telemetry', 'google', 'bing', 'wordpress', 'cdp', 'insights'])
  const resolvedCommand = SUBCOMMAND_COMMANDS.has(command) && args[1] && !args[1].startsWith('-')
    ? `${command}.${args[1]}`
    : command

  // Track CLI command usage (fire-and-forget).
  // Skip for `telemetry` commands — don't track the opt-out flow itself.
  if (command !== 'telemetry') {
    trackEvent('cli.command', { command: resolvedCommand })
  }

  try {
    if (await dispatchRegisteredCommand(args, format, REGISTERED_CLI_COMMANDS)) {
      return 0
    }
    throw usageError(`Error: unknown command: ${command}\nRun "canonry --help" for usage.`, {
      message: `unknown command: ${command}`,
      details: {
        command,
        usage: 'canonry --help',
      },
    })
  } catch (err: unknown) {
    printCliError(err, format)
    return err instanceof CliError ? err.exitCode : EXIT_SYSTEM_ERROR
  }
}

export async function main(args = process.argv.slice(2)) {
  const exitCode = await runCli(args)
  if (exitCode !== 0) {
    process.exitCode = exitCode
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined

if (entrypoint === import.meta.url) {
  void main()
}
