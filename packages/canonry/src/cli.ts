#!/usr/bin/env node --import tsx
import { printCliCatalog } from './cli-catalog.js'
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
import { cliRuntimeContext } from './runtime-context.js'
import type { CliFormat } from './cli-error.js'
import { CliError, EXIT_SYSTEM_ERROR, printCliError, usageError } from './cli-error.js'
import { dispatchRegisteredCommand } from './cli-dispatch.js'
import type { CliCommandSpec } from './cli-dispatch.js'
import { REGISTERED_CLI_COMMANDS } from './cli-commands.js'
import { checkLatestVersionForCli, formatUpdateNotice, notePrintedUpdateAvailable, readCachedUpdateAvailable } from './update-check.js'
import { buildSetupNudgeLine } from './setup-nudge.js'
import { consumePendingServeHandoff } from './commands/init.js'
import { serveCommand } from './commands/serve.js'



import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { version: VERSION } = _require('../package.json') as { version: string }

/** Extract --format flag from args. Returns 'json', 'jsonl', or 'text' (default). */
function extractFormat(cmdArgs: string[]): CliFormat {
  const idx = cmdArgs.indexOf('--format')
  const value = idx !== -1 ? cmdArgs[idx + 1] : cmdArgs.find(arg => arg.startsWith('--format='))?.slice('--format='.length)
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
  'PROVIDERS_FAILING',
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
  'RUN_FILL_REFUSED',
  'RUN_FILL_IN_PROGRESS',
  'RUN_FILL_INCOMPLETE',
  'RUN_FAILED',
  'API_ERROR',
  'CLI_ERROR',
  'CLI_USAGE_ERROR',
  'CLI_SYSTEM_ERROR',
  'CONNECTION_ERROR',
  'UNEXPECTED_RESPONSE_FORMAT',
  'STORED_ONLY_REFUSED',
])

function telemetryErrorCode(err: unknown): string {
  if (!(err instanceof CliError)) return 'CLI_ERROR'
  if (TELEMETRY_ERROR_CODES.has(err.code)) return err.code
  return typeof err.details?.httpStatus === 'number' ? 'API_ERROR' : 'CLI_ERROR'
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const format = extractFormat(args)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printCliCatalog(REGISTERED_CLI_COMMANDS, format)
    return 0
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION)
    return 0
  }

  const command = args[0]!
  const isHelpRequest = command === 'help' || args.includes('--help') || args.includes('-h')
  if (isHelpRequest) {
    try {
      if (!await dispatchRegisteredCommand(args, format, REGISTERED_CLI_COMMANDS)) throw usageError(`Unknown command group: ${command}`)
      return 0
    } catch (error) {
      printCliError(error, format)
      return error instanceof CliError ? error.exitCode : EXIT_SYSTEM_ERROR
    }
  }

  // Demo startup must not read a personal config, send telemetry, refresh
  // installed skills, or start an update check on the hosting machine.
  if (command === 'demo') {
    try {
      await dispatchRegisteredCommand(args, format, REGISTERED_CLI_COMMANDS)
      return 0
    } catch (error) {
      printCliError(error, format)
      return error instanceof CliError ? error.exitCode : EXIT_SYSTEM_ERROR
    }
  }

  // Skip telemetry entirely for help requests — the user is just reading usage

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
      ...cliRuntimeContext(),
    })
  }

  // Update notice for people AND agents. It is printed synchronously from the
  // on-disk cache before the command runs, so it is always the first stderr
  // line and can never interleave with command output; stdout is untouched.
  // The registry refresh runs in the background and only updates the cache,
  // so a new release is announced from the next invocation on. Opt-outs and
  // the 24h TTL live in `update-check.ts`. The shape follows the caller:
  // banner on a terminal, one plain line when captured, one JSON line for
  // `--format json|jsonl`.
  if (!isHelpRequest && command !== 'telemetry') {
    const update = readCachedUpdateAvailable()
    notePrintedUpdateAvailable(update)
    if (update) {
      process.stderr.write(formatUpdateNotice(update, { format, interactive: Boolean(process.stderr.isTTY) }))
    }
    void checkLatestVersionForCli()
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
      // commands and non-interactive runs outside the Page Health handoff must
      // not touch config or the database, and the nudge's own gates guarantee that.
      const nudge = buildSetupNudgeLine({
        command: resolvedCommand,
        format,
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
