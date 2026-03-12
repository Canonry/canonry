#!/usr/bin/env node --import tsx
import { parseArgs } from 'node:util'
import { bootstrapCommand } from './commands/bootstrap.js'
import { initCommand } from './commands/init.js'
import { serveCommand } from './commands/serve.js'
import { createProject, listProjects, showProject, deleteProject } from './commands/project.js'
import { addKeywords, listKeywords, importKeywords, generateKeywords } from './commands/keyword.js'
import { addCompetitors, listCompetitors } from './commands/competitor.js'
import { triggerRun, listRuns } from './commands/run.js'
import { showStatus } from './commands/status.js'
import { showEvidence } from './commands/evidence.js'
import { showHistory } from './commands/history.js'
import { applyConfig } from './commands/apply.js'
import { exportProject } from './commands/export-cmd.js'
import { showSettings, setProvider } from './commands/settings.js'
import { setSchedule, showSchedule, enableSchedule, disableSchedule, removeSchedule } from './commands/schedule.js'
import { addNotification, listNotifications, removeNotification, testNotification } from './commands/notify.js'

const USAGE = `
canonry — AEO monitoring CLI

Usage:
  canonry init [--force]               Initialize config and database
  canonry bootstrap [--force]          Bootstrap config/database from env vars
  canonry serve                       Start the local server
  canonry project create <name>       Create a project
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
  canonry settings                    Show active provider and quota settings
  canonry settings provider <name>    Update a provider config (--api-key, --base-url, --model)
  canonry --help                      Show this help
  canonry --version                   Show version

Options:
  --port <port>        Server port (default: 4100)
  --host <host>        Server bind address (default: 127.0.0.1)
  --domain <domain>    Canonical domain for project create
  --country <code>     Country code (default: US)
  --language <lang>    Language code (default: en)
  --provider <name>    Provider to use (gemini, openai, claude)
  --include-results    Include results in export
  --preset <preset>    Schedule preset (daily, weekly, twice-daily, daily@HH, weekly@DAY)
  --cron <expr>        Cron expression for schedule
  --timezone <tz>      IANA timezone for schedule (default: UTC)
  --webhook <url>      Webhook URL for notifications
  --events <list>      Comma-separated notification events
`.trim()

import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { version: VERSION } = _require('../package.json') as { version: string }

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

  try {
    switch (command) {
      case 'init': {
        const initForce = args.includes('--force') || args.includes('-f')
        await initCommand({ force: initForce })
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
                country: { type: 'string', default: 'US' },
                language: { type: 'string', default: 'en' },
                'display-name': { type: 'string' },
              },
              allowPositionals: false,
            })
            await createProject(name, {
              domain: values.domain ?? name,
              country: values.country ?? 'US',
              language: values.language ?? 'en',
              displayName: values['display-name'] ?? name,
            })
            break
          }
          case 'list':
            await listProjects()
            break
          case 'show': {
            const name = args[2]
            if (!name) {
              console.error('Error: project name is required')
              process.exit(1)
            }
            await showProject(name)
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
            console.log('Available: create, list, show, delete')
            process.exit(1)
        }
        break
      }

      case 'keyword': {
        const subcommand = args[1]
        switch (subcommand) {
          case 'add': {
            const project = args[2]
            const kws = args.slice(3)
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
            await listKeywords(project)
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
            const domains = args.slice(3)
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
            await listCompetitors(project)
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
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        const runParsed = parseArgs({
          args: args.slice(2),
          options: {
            provider: { type: 'string' },
          },
          allowPositionals: false,
        })
        await triggerRun(project, { provider: runParsed.values.provider })
        break
      }

      case 'runs': {
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        await listRuns(project)
        break
      }

      case 'status': {
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        await showStatus(project)
        break
      }

      case 'evidence': {
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        await showEvidence(project)
        break
      }

      case 'history': {
        const project = args[1]
        if (!project) {
          console.error('Error: project name is required')
          process.exit(1)
        }
        await showHistory(project)
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
            await showSchedule(schedProject!)
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
              },
              allowPositionals: false,
            })
            if (!values.webhook) {
              console.error('Error: --webhook is required')
              process.exit(1)
            }
            if (!values.events) {
              console.error('Error: --events is required (comma-separated)')
              process.exit(1)
            }
            await addNotification(notifProject!, {
              webhook: values.webhook,
              events: values.events.split(',').map(e => e.trim()),
            })
            break
          }
          case 'list':
            await listNotifications(notifProject!)
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
            console.log('Available: add, list, remove, test')
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
          await setProvider(name, { apiKey: values['api-key'], baseUrl: values['base-url'], model: values.model })
        } else {
          await showSettings()
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
