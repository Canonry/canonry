#!/usr/bin/env node --import tsx
import { parseArgs } from 'node:util'
import { initCommand } from './commands/init.js'
import { serveCommand } from './commands/serve.js'
import { createProject, listProjects, showProject, deleteProject } from './commands/project.js'
import { addKeywords, listKeywords, importKeywords } from './commands/keyword.js'
import { addCompetitors, listCompetitors } from './commands/competitor.js'
import { triggerRun, listRuns } from './commands/run.js'
import { showStatus } from './commands/status.js'
import { showEvidence } from './commands/evidence.js'
import { showHistory } from './commands/history.js'
import { applyConfig } from './commands/apply.js'
import { exportProject } from './commands/export-cmd.js'

const USAGE = `
canonry — AEO monitoring CLI

Usage:
  canonry init                        Initialize config and database
  canonry serve                       Start the local server
  canonry project create <name>       Create a project
  canonry project list                List all projects
  canonry project show <name>         Show project details
  canonry project delete <name>       Delete a project
  canonry keyword add <project> <kw>  Add keywords to a project
  canonry keyword list <project>      List keywords for a project
  canonry keyword import <project> <file>  Import keywords from file
  canonry competitor add <project> <domain>  Add competitors
  canonry competitor list <project>   List competitors
  canonry run <project>               Trigger a run
  canonry runs <project>              List runs for a project
  canonry status <project>            Show project summary
  canonry evidence <project>          Show keyword-level results
  canonry history <project>           Show audit trail
  canonry export <project>            Export project as YAML
  canonry apply <file>                Apply declarative config
  canonry --help                      Show this help
  canonry --version                   Show version

Options:
  --port <port>        Server port (default: 4100)
  --domain <domain>    Canonical domain for project create
  --country <code>     Country code (default: US)
  --language <lang>    Language code (default: en)
  --include-results    Include results in export
`.trim()

const VERSION = '0.1.0'

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
      case 'init':
        await initCommand()
        break

      case 'serve': {
        const { values } = parseArgs({
          args: args.slice(1),
          options: {
            port: { type: 'string', short: 'p', default: '4100' },
          },
          allowPositionals: false,
        })
        process.env.CANONRY_PORT = values.port
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
              console.error('Error: project name and at least one keyword required')
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
          default:
            console.error(`Unknown keyword subcommand: ${subcommand ?? '(none)'}`)
            console.log('Available: add, list, import')
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
        await triggerRun(project)
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
        const filePath = args[1]
        if (!filePath) {
          console.error('Error: file path is required')
          process.exit(1)
        }
        await applyConfig(filePath)
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
