#!/usr/bin/env node --import tsx
import { pathToFileURL } from 'node:url'
import {
  trackEvent,
  trackCliCommandFinished,
  isTelemetryEnabled,
  isFirstRun,
  getOrCreateAnonymousId,
  showFirstRunNotice,
  detectAndTrackUpgrade,
} from './telemetry.js'
import { autoSyncSkills, formatAutoSyncNotice } from './skills-autosync.js'
import { buildSetupState } from './setup-state.js'
import type { CliFormat } from './cli-error.js'
import { CliError, EXIT_SYSTEM_ERROR, printCliError, usageError } from './cli-error.js'
import { dispatchRegisteredCommand } from './cli-dispatch.js'
import type { CliCommandSpec } from './cli-dispatch.js'
import { REGISTERED_CLI_COMMANDS } from './cli-commands.js'
import { checkLatestVersionForCli } from './update-check.js'
import { buildSetupNudgeLine } from './setup-nudge.js'
import { consumePendingServeHandoff } from './commands/init.js'
import { serveCommand } from './commands/serve.js'
import { isMachineFormat } from './cli-error.js'

const USAGE = `
cnry — AEO monitoring CLI   ('canonry' also works)

Usage:  cnry <command> [options]

Setup:
  init                  Initialize config and database
  bootstrap             Bootstrap config/database from env vars
  serve                 Start the local server (foreground)
  start / stop          Start/stop as a background daemon
  skills                List or install bundled agent skills (claude/codex)

Projects:
  project               Create, update, list, show, delete projects
  query                 Add, replace, remove, list, import, generate queries
  competitor            Add, remove, list competitors

Monitoring:
  run                   Trigger visibility sweeps
  snapshot              One-shot AI perception report
  status <project>      Show project summary
  evidence <project>    Show per-query results
  analytics <project>   Show analytics (metrics, gaps, sources)
  organic-evidence      Reconcile 60/90d search, GA4, and server AI evidence
  insights <project>    Show intelligence insights
  health <project>      Show citation health

Config-as-Code:
  apply <file...>       Apply declarative config (YAML)
  export <project>      Export project as YAML

Integrations:
  google                Google Search Console / Analytics
  bing                  Bing Webmaster Tools
  wordpress             WordPress REST API
  traffic               Server-side traffic ingestion (Cloud Run)

Automation:
  schedule              Manage scheduled runs
  notify                Manage webhook notifications

Admin:
  settings              Show/update providers, gateway connections, and engine routes
  backfill              Backfill answer visibility or insights
  telemetry             Manage anonymous telemetry
  history <project>     Show audit trail

Global options:
  --format json         Machine-readable output: one JSON document (all commands)
  --format jsonl        Machine-readable output: one record per line, no jq needed
  --help, -h            Show help (use with any command group)
  --version, -v         Show version

Run 'cnry <command> --help' for details on a specific command.
`.trim()

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { version: VERSION } = _require('../package.json') as { version: string }

/** Extract --format flag from args. Returns 'json', 'jsonl', or 'text' (default). */
function extractFormat(cmdArgs: string[]): CliFormat {
  const idx = cmdArgs.indexOf('--format')
  const value = idx !== -1 ? cmdArgs[idx + 1] : undefined
  if (value === 'json') return 'json'
  if (value === 'jsonl') return 'jsonl'
  return 'text'
}

/**
 * Resolve argv to the longest registered command path. Unknown input is
 * deliberately collapsed to one stable value so typos, project names, and
 * other positional text can never leak into telemetry or explode cardinality.
 */
function resolveCommandIdentifier(
  args: readonly string[],
  specs: readonly CliCommandSpec[],
): string {
  const spec = [...specs]
    .sort((a, b) => b.path.length - a.path.length)
    .find(candidate =>
      candidate.path.every((segment, index) => args[index] === segment),
    )
  return spec?.path.join('.') ?? 'unknown'
}

const TELEMETRY_ERROR_CODES = new Set([
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'VALIDATION_ERROR',
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'FORBIDDEN',
  'QUOTA_EXCEEDED',
  'PROVIDER_ERROR',
  'NO_PROVIDER',
  'NO_QUERIES',
  'RUN_IN_PROGRESS',
  'OPERATION_IN_PROGRESS',
  'UNSUPPORTED_KIND',
  'RUN_NOT_CANCELLABLE',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
  'DELIVERY_FAILED',
  'AGENT_BUSY',
  'MISSING_DEPENDENCY',
  'RUNTIME_STATE_MISSING',
  'API_ERROR',
  'CLI_ERROR',
  'CLI_USAGE_ERROR',
  'CLI_SYSTEM_ERROR',
  'CONNECTION_ERROR',
  'UNEXPECTED_RESPONSE_FORMAT',
])

function telemetryErrorCode(err: unknown): string {
  if (!(err instanceof CliError)) return 'CLI_ERROR'
  if (TELEMETRY_ERROR_CODES.has(err.code)) return err.code
  return typeof err.details?.httpStatus === 'number' ? 'API_ERROR' : 'CLI_ERROR'
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

  // Skip telemetry entirely for help requests — the user is just reading usage
  const isHelpRequest = args.includes('--help') || args.includes('-h')

  // First-run telemetry notice (shown once, to stderr).
  // Skip for the `telemetry` command itself — the user may be about to disable it,
  // and we should not create an anonymousId before they get the chance to opt out.
  if (!isHelpRequest && command !== 'telemetry' && command !== 'init' && isTelemetryEnabled() && isFirstRun()) {
    showFirstRunNotice()
    getOrCreateAnonymousId()
  }

  const resolvedCommand = resolveCommandIdentifier(args, REGISTERED_CLI_COMMANDS)
  const shouldTrackCommand =
    !isHelpRequest &&
    command !== 'telemetry' &&
    isTelemetryEnabled()
  // `init` creates and persists the install identity itself. Emitting before
  // dispatch would use the config-less machine fallback, then split the same
  // attempt across a new persisted anonymousId. Its post-command lifecycle
  // event is still emitted below.
  const shouldTrackCommandStart = shouldTrackCommand && command !== 'init'

  // Track CLI command usage (fire-and-forget).
  // Skip for `telemetry` commands and help requests.
  // Refresh installed skills when the engine moved under them, or on the
  // re-verify timer. Deliberately OUTSIDE the telemetry gate below: this is a
  // correctness behaviour, and tying it to an analytics opt-in would give the
  // users who opt out a quietly worse product. Never throws, never overwrites a
  // local edit, and prints only when it left one alone.
  void autoSyncSkills().then((result) => {
    const notice = formatAutoSyncNotice(result)
    if (notice && process.stderr.isTTY) console.error(notice)
  })

  if (shouldTrackCommandStart) {
    // Emit `cli.upgraded` once per version bump, before `cli.command`, so
    // upgrade events are correlated with the first command on the new build.
    detectAndTrackUpgrade()
    const setupState = buildSetupState()
    trackEvent('cli.command', {
      command: resolvedCommand,
      ...(setupState ? { setup_state: setupState } : {}),
    })
  }

  // Surface a new-version banner before the command runs. Opt-outs and the
  // 24h cache live in `update-check.ts`; this stays a no-op when the
  // registry is unreachable, the user is offline, or no upgrade is
  // available. Banner goes to stderr so it never pollutes `--format json`.
  //
  // Gated on an interactive stderr: when output is piped or captured (the
  // agent case), this fire-and-forget banner is skipped entirely so it can
  // never interleave with command output or force callers to add `2>/dev/null`.
  if (!isHelpRequest && command !== 'telemetry' && process.stderr.isTTY) {
    void checkLatestVersionForCli().then((update) => {
      if (!update) return
      process.stderr.write(
        `\n→ canonry ${update.latest} is available (you have ${update.current}).\n` +
        `  Upgrade: ${update.upgradeCommand}\n\n`,
      )
    })
  }

  const commandStartedAt = Date.now()

  try {
    if (await dispatchRegisteredCommand(args, format, REGISTERED_CLI_COMMANDS)) {
      if (shouldTrackCommand) {
        trackCliCommandFinished({
          command: resolvedCommand,
          success: true,
          durationMs: Date.now() - commandStartedAt,
          setupState: buildSetupState(),
        })
      }
      // The stalled-setup line. Independent of telemetry consent (it is user
      // guidance, not measurement), but LAZY about reading state: control
      // commands and non-interactive runs must not touch config or the
      // database, and the nudge's own gates guarantee that.
      const nudge = buildSetupNudgeLine({
        command: resolvedCommand,
        machineFormat: isMachineFormat(format),
        stderrIsTTY: Boolean(process.stderr.isTTY),
        getSetupState: buildSetupState,
      })
      if (nudge) process.stderr.write(nudge)
      // Init's dashboard handoff, honored only after init's own lifecycle
      // event is on the wire so serve's unbounded runtime cannot pollute
      // init's duration bucket.
      if (consumePendingServeHandoff()) {
        await serveCommand(format as CliFormat)
      }
      return 0
    }
    throw usageError(`Error: unknown command: ${command}\nRun "cnry --help" for usage.`, {
      message: `unknown command: ${command}`,
      details: {
        command,
        usage: 'cnry --help',
      },
    })
  } catch (err: unknown) {
    // A failed init has not established the persisted identity or shown the
    // disclosure yet, so it must remain completely silent.
    if (shouldTrackCommand && command !== 'init') {
      trackCliCommandFinished({
        command: resolvedCommand,
        success: false,
        durationMs: Date.now() - commandStartedAt,
        setupState: buildSetupState(),
        errorCode: telemetryErrorCode(err),
      })
    }
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
