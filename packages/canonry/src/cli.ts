#!/usr/bin/env node --import tsx
import { parseArgs } from 'node:util'
import { bootstrapCommand } from './commands/bootstrap.js'
import { initCommand } from './commands/init.js'
import { serveCommand } from './commands/serve.js'
import { startDaemon, stopDaemon } from './commands/daemon.js'
import { createProject, listProjects, showProject, deleteProject, updateProjectSettings } from './commands/project.js'
import { addKeywords, listKeywords, importKeywords, generateKeywords } from './commands/keyword.js'
import { addCompetitors, listCompetitors } from './commands/competitor.js'
import { triggerRun, triggerRunAll, showRun, listRuns } from './commands/run.js'
import { showStatus } from './commands/status.js'
import { showEvidence } from './commands/evidence.js'
import { showHistory } from './commands/history.js'
import { applyConfig } from './commands/apply.js'
import { exportProject } from './commands/export-cmd.js'
import { showSettings, setProvider, setGoogleAuth } from './commands/settings.js'
import { setSchedule, showSchedule, enableSchedule, disableSchedule, removeSchedule } from './commands/schedule.js'
import { addNotification, listNotifications, removeNotification, testNotification, listEvents } from './commands/notify.js'
import { telemetryCommand } from './commands/telemetry.js'
import {
  googleConnect, googleDisconnect, googleStatus, googleProperties,
  googleSetProperty, googleSync, googlePerformance, googleInspect,
  googleInspections, googleDeindexed,
} from './commands/google.js'
import { trackEvent, isTelemetryEnabled, isFirstRun, getOrCreateAnonymousId, showFirstRunNotice } from './telemetry.js'

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
  canonry keyword add <project> <kw>  Add key phrases to a project
  canonry keyword list <project>      List key phrases for a project
  canonry keyword import <project> <file>  Import key phrases from file
  canonry keyword generate <project>  Auto-generate key phrases (--provider, --count, --save)
  canonry competitor add <project> <domain>  Add competitors
  canonry competitor list <project>   List competitors
  canonry run <project>               Trigger a run (all providers)
  canonry run <project> --provider <name>  Trigger a run for a specific provider
  canonry run <project> --wait        Trigger and wait for completion
  canonry run --all                   Trigger runs for all projects
  canonry run show <id>               Show run details and snapshots
  canonry runs <project>              List runs for a project
  canonry status <project>            Show project summary
  canonry evidence <project>          Show per-phrase results
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
  canonry google connect <project>     Connect Google Search Console (--type gsc|ga4)
  canonry google disconnect <project> Disconnect Google integration
  canonry google status <project>     Show Google connection status
  canonry google properties <project> List available GSC properties
  canonry google set-property <project> <url>  Set GSC property URL
  canonry google sync <project>       Sync GSC data (--days 30, --full, --wait)
  canonry google performance <project>  Show GSC search performance data
  canonry google inspect <project> <url>  Inspect a URL via GSC
  canonry google inspections <project>  Show URL inspection history (--url <url>)
  canonry google deindexed <project>  Show pages that lost indexing
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
  --provider <name>    Provider to use (gemini, openai, claude, local)
  --format <fmt>       Output format: text (default) or json
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

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION)
    return
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
  const SUBCOMMAND_COMMANDS = new Set(['project', 'keyword', 'competitor', 'schedule', 'notify', 'settings', 'telemetry', 'google'])
  const resolvedCommand = SUBCOMMAND_COMMANDS.has(command) && args[1] && !args[1].startsWith('-')
    ? `${command}.${args[1]}`
    : command

  // Track CLI command usage (fire-and-forget).
  // Skip for `telemetry` commands — don't track the opt-out flow itself.
  if (command !== 'telemetry') {
    trackEvent('cli.command', { command: resolvedCommand })
  }

  try {
    switch (command) {
      case 'init': {
        const { values: initValues } = parseArgs({
          args: args.slice(1),
          options: {
            force: { type: 'boolean', short: 'f', default: false },
            'gemini-key': { type: 'string' },
            'openai-key': { type: 'string' },
            'claude-key': { type: 'string' },
            'local-url': { type: 'string' },
            'local-model': { type: 'string' },
            'local-key': { type: 'string' },
            'google-client-id': { type: 'string' },
            'google-client-secret': { type: 'string' },
          },
          allowPositionals: false,
        })
        await initCommand({
          force: initValues.force,
          geminiKey: initValues['gemini-key'],
          openaiKey: initValues['openai-key'],
          claudeKey: initValues['claude-key'],
          localUrl: initValues['local-url'],
          localModel: initValues['local-model'],
          localKey: initValues['local-key'],
          googleClientId: initValues['google-client-id'],
          googleClientSecret: initValues['google-client-secret'],
        })
        break
      }

      case 'bootstrap': {
        const bootstrapForce = args.includes('--force') || args.includes('-f')
        await bootstrapCommand({ force: bootstrapForce })
        break
      }

      case 'serve': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            port: { type: 'string', short: 'p', default: '4100' },
            host: { type: 'string', short: 'H' },
          },
          allowPositionals: false,
        })
        process.env.CANONRY_PORT = values.port
        if (values.host) process.env.CANONRY_HOST = values.host
        await serveCommand()
        break
      }

      case 'start': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            port: { type: 'string', short: 'p', default: '4100' },
            host: { type: 'string', short: 'H' },
          },
          allowPositionals: false,
        })
        await startDaemon({ port: values.port, host: values.host })
        break
      }

      case 'stop': {
        stopDaemon()
        break
      }

      case 'project': {
        const subcommand = args[1]
        switch (subcommand) {
          case 'create': {
            const name = args[2]
            if (!name) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            const { values } = parseArgs({
              args: args.slice(3),
              options: {
                domain: { type: 'string', short: 'd' },
                'owned-domain': { type: 'string', multiple: true },
                country: { type: 'string', default: 'US' },
                language: { type: 'string', default: 'en' },
                'display-name': { type: 'string' },
                format: { type: 'string' },
              },
              allowPositionals: false,
            })
            await createProject(name, {
              domain: values.domain ?? name,
              ownedDomains: values['owned-domain'] ?? [],
              country: values.country ?? 'US',
              language: values.language ?? 'en',
              displayName: values['display-name'] ?? name,
            })
            break
          }
          case 'update': {
            const name = args[2]
            if (!name) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            const { values } = parseArgs({
              args: args.slice(3),
              options: {
                domain: { type: 'string', short: 'd' },
                'owned-domain': { type: 'string', multiple: true },
                'add-domain': { type: 'string', multiple: true },
                'remove-domain': { type: 'string', multiple: true },
                country: { type: 'string' },
                language: { type: 'string' },
                'display-name': { type: 'string' },
                format: { type: 'string' },
              },
              allowPositionals: false,
            })
            await updateProjectSettings(name, {
              displayName: values['display-name'],
              domain: values.domain,
              ownedDomains: values['owned-domain'],
              addOwnedDomain: values['add-domain'],
              removeOwnedDomain: values['remove-domain'],
              country: values.country,
              language: values.language,
            })
            break
          }
          case 'list':
            await listProjects(format)
            break
          case 'show': {
            const name = args[2]
            if (!name) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            await showProject(name, format)
            break
          }
          case 'delete': {
            const name = args[2]
            if (!name) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            await deleteProject(name)
            break
          }
          default:
            console.error(`Unknown project subcommand: ${subcommand ?? '(none)'}`)
            console.log('Available: create, update, list, show, delete')
            process.exit(1)
        }
        break
      }

      case 'keyword': {
        const subcommand = args[1]
        switch (subcommand) {
          case 'add': {
            const project = args[2]
            const kws = args.slice(3).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')))
            if (!project || kws.length === 0) {
              console.error('Error: project name and at least one key phrase required')
              process.exit(1)
            }
            await addKeywords(project, kws)
            break
          }
          case 'list': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            await listKeywords(project, format)
            break
          }
          case 'import': {
            const project = args[2]
            const filePath = args[3]
            if (!project || !filePath) {
              console.error('Error: project name and file path required')
              process.exit(1)
            }
            await importKeywords(project, filePath)
            break
          }
          case 'generate': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            const { values } = parseArgs({
              args: args.slice(3),
              options: {
                provider: { type: 'string' },
                count: { type: 'string' },
                save: { type: 'boolean', default: false },
                format: { type: 'string' },
              },
              allowPositionals: false,
            })
            if (!values.provider) {
              console.error('Error: --provider is required (gemini, openai, claude, local)')
              process.exit(1)
            }
            await generateKeywords(project, values.provider, {
              count: values.count ? parseInt(values.count, 10) : undefined,
              save: values.save,
            })
            break
          }
          default:
            console.error(`Unknown keyword subcommand: ${subcommand ?? '(none)'}`)
            console.log('Available: add, list, import, generate')
            process.exit(1)
        }
        break
      }

      case 'competitor': {
        const subcommand = args[1]
        switch (subcommand) {
          case 'add': {
            const project = args[2]
            const domains = args.slice(3).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')))
            if (!project || domains.length === 0) {
              console.error('Error: project name and at least one domain required')
              process.exit(1)
            }
            await addCompetitors(project, domains)
            break
          }
          case 'list': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            await listCompetitors(project, format)
            break
          }
          default:
            console.error(`Unknown competitor subcommand: ${subcommand ?? '(none)'}`)
            console.log('Available: add, list')
            process.exit(1)
        }
        break
      }

      case 'run': {
        // Handle 'run show <id>'
        if (args[1] === 'show') {
          const id = args[2]
          if (!id) {
            console.error('Error: run ID is required')
            process.exit(1)
          }
          await showRun(id, format)
          break
        }

        const runParsed = parseArgs({
          args: args.slice(1),
          options: {
            provider: { type: 'string' },
            wait: { type: 'boolean', default: false },
            all: { type: 'boolean', default: false },
            format: { type: 'string' },
          },
          allowPositionals: true,
        })

        const runFormat = runParsed.values.format === 'json' ? 'json' : format

        if (runParsed.values.all) {
          if (runParsed.positionals.length > 0) {
            console.error('Error: --all cannot be combined with a project name')
            process.exit(1)
          }
          await triggerRunAll({
            provider: runParsed.values.provider,
            wait: runParsed.values.wait,
            format: runFormat,
          })
        } else {
          const project = runParsed.positionals[0]
          if (!project) {
            console.error('Error: project name is required (or use --all)')
            process.exit(1)
          }
          await triggerRun(project, {
            provider: runParsed.values.provider,
            wait: runParsed.values.wait,
            format: runFormat,
          })
        }
        break
      }

      case 'runs': {
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        await listRuns(project, format)
        break
      }

      case 'status': {
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        await showStatus(project, format)
        break
      }

      case 'evidence': {
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        await showEvidence(project, format)
        break
      }

      case 'history': {
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        await showHistory(project, format)
        break
      }

      case 'export': {
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        const includeResults = args.includes('--include-results')
        await exportProject(project, { includeResults })
        break
      }

      case 'apply': {
        const filePaths = args.slice(1).filter(a => !a.startsWith('-'))
        if (filePaths.length === 0) {
          console.error('Error: at least one file path is required')
          process.exit(1)
        }
        const applyErrors: string[] = []
        for (const fp of filePaths) {
          try {
            await applyConfig(fp)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            applyErrors.push(msg)
          }
        }
        if (applyErrors.length > 0) {
          for (const e of applyErrors) console.error(e)
          process.exit(1)
        }
        break
      }

      case 'schedule': {
        const subcommand = args[1]
        const schedProject = args[2]
        if (!schedProject && subcommand !== undefined) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        switch (subcommand) {
          case 'set': {
            const { values } = parseArgs({
              args: args.slice(3),
              options: {
                preset: { type: 'string' },
                cron: { type: 'string' },
                timezone: { type: 'string' },
                provider: { type: 'string', multiple: true },
                format: { type: 'string' },
              },
              allowPositionals: false,
            })
            if (!values.preset && !values.cron) {
              console.error('Error: --preset or --cron is required')
              process.exit(1)
            }
            await setSchedule(schedProject!, {
              preset: values.preset,
              cron: values.cron,
              timezone: values.timezone,
              providers: values.provider,
            })
            break
          }
          case 'show':
            await showSchedule(schedProject!, format)
            break
          case 'enable':
            await enableSchedule(schedProject!)
            break
          case 'disable':
            await disableSchedule(schedProject!)
            break
          case 'remove':
            await removeSchedule(schedProject!)
            break
          default:
            console.error(`Unknown schedule subcommand: ${subcommand ?? '(none)'}`)
            console.log('Available: set, show, enable, disable, remove')
            process.exit(1)
        }
        break
      }

      case 'notify': {
        const notifSubcommand = args[1]

        // 'events' subcommand does not require a project
        if (notifSubcommand === 'events') {
          listEvents(format)
          break
        }

        const notifProject = args[2]
        if (!notifProject && notifSubcommand !== undefined) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        switch (notifSubcommand) {
          case 'add': {
            const { values } = parseArgs({
              args: args.slice(3),
              options: {
                webhook: { type: 'string' },
                events: { type: 'string' },
                format: { type: 'string' },
              },
              allowPositionals: false,
            })
            if (!values.webhook) {
              console.error('Error: --webhook is required')
              process.exit(1)
            }
            if (!values.events) {
              console.error('Error: --events is required (comma-separated). Use "canonry notify events" to see valid events.')
              process.exit(1)
            }
            await addNotification(notifProject!, {
              webhook: values.webhook,
              events: values.events.split(',').map(e => e.trim()),
            })
            break
          }
          case 'list':
            await listNotifications(notifProject!, format)
            break
          case 'remove': {
            const notifId = args[3]
            if (!notifId) {
              console.error('Error: notification ID is required')
              process.exit(1)
            }
            await removeNotification(notifProject!, notifId)
            break
          }
          case 'test': {
            const testId = args[3]
            if (!testId) {
              console.error('Error: notification ID is required')
              process.exit(1)
            }
            await testNotification(notifProject!, testId)
            break
          }
          default:
            console.error(`Unknown notify subcommand: ${notifSubcommand ?? '(none)'}`)
            console.log('Available: add, list, remove, test, events')
            process.exit(1)
        }
        break
      }

      case 'settings': {
        const subcommand = args[1]
        if (subcommand === 'provider') {
          const name = args[2]
          if (!name) {
            console.error('Error: provider name is required (gemini, openai, claude, local)')
            process.exit(1)
          }
          const { values } = parseArgs({
            args: args.slice(3),
            options: {
              'api-key': { type: 'string' },
              'base-url': { type: 'string' },
              model: { type: 'string' },
              'max-concurrent': { type: 'string' },
              'max-per-minute': { type: 'string' },
              'max-per-day': { type: 'string' },
              format: { type: 'string' },
            },
            allowPositionals: false,
          })
          if (name === 'local') {
            if (!values['base-url']) {
              console.error('Error: --base-url is required for the local provider')
              process.exit(1)
            }
          } else {
            if (!values['api-key']) {
              console.error('Error: --api-key is required')
              process.exit(1)
            }
          }

          // Build quota object from flags (only include provided values)
          const quota: Record<string, number> = {}
          if (values['max-concurrent']) quota.maxConcurrency = parseInt(values['max-concurrent'], 10)
          if (values['max-per-minute']) quota.maxRequestsPerMinute = parseInt(values['max-per-minute'], 10)
          if (values['max-per-day']) quota.maxRequestsPerDay = parseInt(values['max-per-day'], 10)

          await setProvider(name, {
            apiKey: values['api-key'],
            baseUrl: values['base-url'],
            model: values.model,
            quota: Object.keys(quota).length > 0 ? quota : undefined,
          })
        } else if (subcommand === 'google') {
          const { values } = parseArgs({
            args: args.slice(2),
            options: {
              'client-id': { type: 'string' },
              'client-secret': { type: 'string' },
            },
            allowPositionals: false,
          })
          if (!values['client-id'] || !values['client-secret']) {
            console.error('Error: --client-id and --client-secret are both required')
            process.exit(1)
          }
          setGoogleAuth({
            clientId: values['client-id'],
            clientSecret: values['client-secret'],
          })
        } else {
          await showSettings(format)
        }
        break
      }

      case 'telemetry': {
        telemetryCommand(args[1])
        break
      }

      case 'google': {
        const subcommand = args[1]
        switch (subcommand) {
          case 'connect': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            const { values: connectValues } = parseArgs({
              args: args.slice(3),
              options: {
                type: { type: 'string', default: 'gsc' },
              },
              allowPositionals: false,
            })
            await googleConnect(project, { type: connectValues.type ?? 'gsc' })
            break
          }
          case 'disconnect': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            const { values: disconnectValues } = parseArgs({
              args: args.slice(3),
              options: {
                type: { type: 'string', default: 'gsc' },
              },
              allowPositionals: false,
            })
            await googleDisconnect(project, { type: disconnectValues.type ?? 'gsc' })
            break
          }
          case 'status': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            await googleStatus(project, format)
            break
          }
          case 'properties': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            await googleProperties(project, format)
            break
          }
          case 'set-property': {
            const project = args[2]
            const propertyUrl = args[3]
            if (!project || !propertyUrl) {
              console.error('Error: project name and property URL are required')
              process.exit(1)
            }
            await googleSetProperty(project, propertyUrl)
            break
          }
          case 'sync': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            const { values: syncValues } = parseArgs({
              args: args.slice(3),
              options: {
                type: { type: 'string', default: 'gsc' },
                days: { type: 'string' },
                full: { type: 'boolean', default: false },
                wait: { type: 'boolean', default: false },
                format: { type: 'string' },
              },
              allowPositionals: false,
            })
            await googleSync(project, {
              type: syncValues.type,
              days: syncValues.days ? parseInt(syncValues.days, 10) : undefined,
              full: syncValues.full,
              wait: syncValues.wait,
              format: syncValues.format === 'json' ? 'json' : format,
            })
            break
          }
          case 'performance': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            const { values: perfValues } = parseArgs({
              args: args.slice(3),
              options: {
                days: { type: 'string' },
                keyword: { type: 'string' },
                page: { type: 'string' },
                format: { type: 'string' },
              },
              allowPositionals: false,
            })
            await googlePerformance(project, {
              days: perfValues.days ? parseInt(perfValues.days, 10) : undefined,
              keyword: perfValues.keyword,
              page: perfValues.page,
              format: perfValues.format === 'json' ? 'json' : format,
            })
            break
          }
          case 'inspect': {
            const project = args[2]
            const url = args[3]
            if (!project || !url) {
              console.error('Error: project name and URL are required')
              process.exit(1)
            }
            await googleInspect(project, url, format)
            break
          }
          case 'inspections': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            const { values: inspValues } = parseArgs({
              args: args.slice(3),
              options: {
                url: { type: 'string' },
                format: { type: 'string' },
              },
              allowPositionals: false,
            })
            await googleInspections(project, {
              url: inspValues.url,
              format: inspValues.format === 'json' ? 'json' : format,
            })
            break
          }
          case 'deindexed': {
            const project = args[2]
            if (!project) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            await googleDeindexed(project, format)
            break
          }
          default:
            console.error(`Unknown google subcommand: ${subcommand ?? '(none)'}`)
            console.log('Available: connect, disconnect, status, properties, set-property, sync, performance, inspect, inspections, deindexed')
            process.exit(1)
        }
        break
      }

      default:
        console.error(`Unknown command: ${command}`)
        console.log('Run "canonry --help" for usage.')
        process.exit(1)
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(`Error: ${err.message}`)
    } else {
      console.error('An unexpected error occurred')
    }
    process.exit(1)
  }
}

main()
