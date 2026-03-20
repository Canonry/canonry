#!/usr/bin/env node --import tsx
import { pathToFileURL } from 'node:url'
import { trackEvent, isTelemetryEnabled, isFirstRun, getOrCreateAnonymousId, showFirstRunNotice } from './telemetry.js'
import { printCliError, usageError } from './cli-error.js'
import { dispatchRegisteredCommand } from './cli-dispatch.js'
import { REGISTERED_CLI_COMMANDS } from './cli-commands.js'

const USAGE = `
canonry — AEO monitoring CLI

Usage:
  canonry init [--force]               Initialize config and database (interactive)
  canonry init --gemini-key <key>     Initialize non-interactively (also reads env vars)
  canonry bootstrap [--force]          Bootstrap config/database from env vars
  canonry serve                       Start the local server (foreground)
  canonry start                       Start the server as a background daemon
  canonry stop                        Stop the background daemon
  canonry project create <name>       Create a project
  canonry project update <name>       Update project settings
  canonry project list                List all projects
  canonry project show <name>         Show project details
  canonry project delete <name>       Delete a project
  canonry project add-location <name> Add a location (--label, --city, --region, --country)
  canonry project locations <name>    List locations for a project
  canonry project remove-location <name> <label>  Remove a location
  canonry project set-default-location <name> <label>  Set default location
  canonry keyword add <project> <kw>  Add key phrases to a project
  canonry keyword remove <project> <kw>  Remove key phrases from a project
  canonry keyword list <project>      List key phrases for a project
  canonry keyword import <project> <file>  Import key phrases from file
  canonry keyword generate <project>  Auto-generate key phrases (--provider, --count, --save)
  canonry competitor add <project> <domain>  Add competitors
  canonry competitor list <project>   List competitors
  canonry run <project>               Trigger a run (all providers)
  canonry run <project> --provider <name>  Trigger a run for a specific provider
  canonry run <project> --location <label> Run with a specific location
  canonry run <project> --all-locations    Run for every configured location (N× API calls)
  canonry run <project> --no-location      Explicitly skip location context
  canonry run <project> --wait        Trigger and wait for completion
  canonry run --all                   Trigger runs for all projects
  canonry run show <id>               Show run details and snapshots
  canonry runs <project>              List runs for a project
  canonry status <project>            Show project summary
  canonry evidence <project>          Show per-phrase results
  canonry analytics <project>         Show analytics (--feature metrics|gaps|sources, --window 7d|30d|90d|all)
  canonry history <project>           Show audit trail
  canonry export <project>            Export project as YAML
  canonry apply <file...>              Apply declarative config (multi-doc YAML supported)
  canonry schedule set <project>      Set schedule (--preset or --cron)
  canonry schedule show <project>     Show schedule
  canonry schedule enable <project>   Enable schedule
  canonry schedule disable <project>  Disable schedule
  canonry schedule remove <project>   Remove schedule
  canonry notify add <project>        Add webhook notification
  canonry notify list <project>       List notifications
  canonry notify remove <project> <id>  Remove notification
  canonry notify test <project> <id>  Send test webhook
  canonry notify events               List available notification event types
  canonry google connect <project>     Connect Google Search Console (--type gsc|ga4, --public-url <url>)
  canonry google disconnect <project> Disconnect Google integration
  canonry google status <project>     Show Google connection status
  canonry google properties <project> List available GSC properties
  canonry google set-property <project> <url>  Set GSC property URL
  canonry google set-sitemap <project> <url>   Set GSC sitemap URL
  canonry google list-sitemaps <project>       List submitted sitemaps from GSC (no run queued)
  canonry google discover-sitemaps <project>   Auto-discover sitemaps from GSC and queue inspection (--wait)
  canonry google sync <project>       Sync GSC data (--days 30, --full, --wait)
  canonry google performance <project>  Show GSC search performance data
  canonry google inspect <project> <url>  Inspect a URL via GSC
  canonry google inspect-sitemap <project>  Bulk inspect all URLs from sitemap (--sitemap-url, --wait)
  canonry google request-indexing <project> <url>  Request Google indexing for a URL
  canonry google request-indexing <project> --all-unindexed  Request indexing for all unindexed URLs
  canonry google coverage <project>  Show index coverage summary
  canonry google inspections <project>  Show URL inspection history (--url <url>)
  canonry google deindexed <project>  Show pages that lost indexing
  canonry bing connect <project>     Connect Bing Webmaster Tools (prompted for API key)
  canonry bing disconnect <project>  Disconnect Bing integration
  canonry bing status <project>      Show Bing connection status
  canonry bing sites <project>       List registered Bing sites
  canonry bing set-site <project> <url>  Set active Bing site
  canonry bing coverage <project>    Show Bing index coverage summary
  canonry bing inspect <project> <url>  Inspect a URL via Bing
  canonry bing inspections <project>  Show Bing URL inspection history (--url <url>)
  canonry bing request-indexing <project> <url>  Submit URL to Bing for indexing
  canonry bing request-indexing <project> --all-unindexed  Submit all unindexed URLs to Bing
  canonry bing performance <project>  Show Bing search performance data
  canonry settings                    Show active provider and quota settings
  canonry settings provider <name>    Update a provider config
  canonry settings google             Update Google OAuth credentials
  canonry telemetry status            Show telemetry status
  canonry telemetry enable            Enable anonymous telemetry
  canonry telemetry disable           Disable anonymous telemetry
  canonry --help                      Show this help
  canonry --version                   Show version

Options:
  --gemini-key <key>   Gemini API key (or GEMINI_API_KEY env var)
  --openai-key <key>   OpenAI API key (or OPENAI_API_KEY env var)
  --claude-key <key>   Anthropic API key (or ANTHROPIC_API_KEY env var)
  --local-url <url>    Local LLM base URL (or LOCAL_BASE_URL env var)
  --local-model <name> Local LLM model name (default: llama3)
  --local-key <key>    Local LLM API key (or LOCAL_API_KEY env var)
  --google-client-id <id>      Google OAuth client ID (or GOOGLE_CLIENT_ID env var)
  --google-client-secret <key> Google OAuth client secret (or GOOGLE_CLIENT_SECRET env var)
  --port <port>        Server port (default: 4100)
  --host <host>        Server bind address (default: 127.0.0.1)
  --domain <domain>    Canonical domain for project create/update
  --owned-domain <domain>  Additional owned domain for citation matching (repeatable)
  --add-domain <domain>    Add an owned domain (project update, repeatable)
  --remove-domain <domain> Remove an owned domain (project update, repeatable)
  --display-name <name>    Display name for project create/update
  --country <code>     Country code (default: US)
  --language <lang>    Language code (default: en)
  --provider <name>    Provider to use (gemini, openai, claude, local, cdp:chatgpt, or cdp for all CDP targets)
  --format <fmt>       Output format: text (default) or json
  --location <label>   Run with a specific configured location
  --all-locations      Run for every configured location
  --no-location        Explicitly skip location context
  --wait               Wait for run to complete before returning
  --all                Run all projects (with 'run' command)
  --include-results    Include results in export
  --preset <preset>    Schedule preset (daily, weekly, twice-daily, daily@HH, weekly@DAY)
  --cron <expr>        Cron expression for schedule
  --timezone <tz>      IANA timezone for schedule (default: UTC)
  --webhook <url>      Webhook URL for notifications
  --events <list>      Comma-separated notification events
  --api-key <key>      Provider API key (settings provider)
  --base-url <url>     Provider base URL (settings provider)
  --model <name>       Provider model name (settings provider)
  --client-id <id>     Google OAuth client ID (settings google)
  --client-secret <key> Google OAuth client secret (settings google)
  --max-concurrent <n> Max concurrent requests per provider
  --max-per-minute <n> Max requests per minute per provider
  --max-per-day <n>    Max requests per day per provider
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
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
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
  const SUBCOMMAND_COMMANDS = new Set(['project', 'keyword', 'competitor', 'schedule', 'notify', 'settings', 'telemetry', 'google', 'bing', 'cdp'])
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
    return 1
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
