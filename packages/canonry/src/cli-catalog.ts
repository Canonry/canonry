import { createRequire } from 'node:module'
import type { ParseArgsOptionsConfig } from 'node:util'
import { OperationAccesses, type CliCatalogDto, type OperationAccess } from '@canonry/canonry-contracts'
import { CLI_GLOBAL_OPTIONS, commandOptions, commandUsage, printGroupHelp, type CliCommandSpec } from './cli-dispatch.js'
import { type CliFormat, usageError } from './cli-error.js'
import { emitJsonl } from './cli-output.js'
import { resolveCliAccess } from './cli-access.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export const CLI_ROOT_SUMMARIES: Record<string, { section: string; summary: string }> = {
  "seo": {
    "section": "Integrations",
    "summary": "Read stored SEO evidence and explicitly refresh saved profiles"
  },
  "bootstrap": {
    "section": "Setup",
    "summary": "Create local config/database (no provider required)"
  },
  "serve": {
    "section": "Setup",
    "summary": "Start the local server (foreground)"
  },
  "demo": {
    "section": "Setup",
    "summary": "Serve a public view-only sample dashboard"
  },
  "init": {
    "section": "Setup",
    "summary": "Optional interactive provider/OAuth provisioning"
  },
  "skills": {
    "section": "Setup",
    "summary": "List or install bundled agent skills (claude/codex)"
  },
  "technical-aeo": {
    "section": "Page Health",
    "summary": "Crawl, score, and inspect site health evidence"
  },
  "doctor": {
    "section": "Page Health",
    "summary": "Diagnose runtime and integration health"
  },
  "project": {
    "section": "Projects",
    "summary": "Create, update, list, show, delete projects"
  },
  "query": {
    "section": "Projects",
    "summary": "Add, replace, remove, list, import, generate queries"
  },
  "competitor": {
    "section": "Projects",
    "summary": "Add, remove, list competitors and their aliases"
  },
  "run": {
    "section": "Monitoring",
    "summary": "Trigger visibility sweeps"
  },
  "runs": {
    "section": "Monitoring",
    "summary": "List runs (filter by --kind, --status, --since)"
  },
  "snapshot": {
    "section": "Monitoring",
    "summary": "One-shot AI perception report"
  },
  "status": {
    "section": "Monitoring",
    "summary": "Show project summary"
  },
  "evidence": {
    "section": "Monitoring",
    "summary": "Show per-query results"
  },
  "analytics": {
    "section": "Monitoring",
    "summary": "Show analytics (metrics, gaps, sources)"
  },
  "organic-evidence": {
    "section": "Monitoring",
    "summary": "Reconcile 60/90d search, GA4, and server AI evidence"
  },
  "insights": {
    "section": "Monitoring",
    "summary": "Show intelligence insights"
  },
  "health": {
    "section": "Monitoring",
    "summary": "Show citation health"
  },
  "apply": {
    "section": "Config-as-Code",
    "summary": "Apply declarative config (YAML)"
  },
  "export": {
    "section": "Config-as-Code",
    "summary": "Export project as YAML"
  },
  "google": {
    "section": "Integrations",
    "summary": "Google Search Console / Analytics"
  },
  "bing": {
    "section": "Integrations",
    "summary": "Bing Webmaster Tools"
  },
  "wordpress": {
    "section": "Integrations",
    "summary": "WordPress REST API"
  },
  "traffic": {
    "section": "Integrations",
    "summary": "Server-side traffic ingestion (Cloud Run)"
  },
  "journeys": {
    "section": "Integrations",
    "summary": "AI visitor journeys from server-side traffic"
  },
  "schedule": {
    "section": "Automation",
    "summary": "Manage scheduled runs"
  },
  "notify": {
    "section": "Automation",
    "summary": "Manage webhook notifications"
  },
  "settings": {
    "section": "Admin",
    "summary": "Show/update provider and quota settings"
  },
  "dashboard": {
    "section": "Admin",
    "summary": "Reset the dashboard password"
  },
  "backfill": {
    "section": "Admin",
    "summary": "Backfill answer visibility or insights"
  },
  "telemetry": {
    "section": "Admin",
    "summary": "Manage anonymous telemetry"
  },
  "history": {
    "section": "Admin",
    "summary": "Show audit trail"
  },
  "support": {
    "section": "Admin",
    "summary": "Get help: Canonry Discord and issue tracker"
  },
  "start": {
    "section": "Setup",
    "summary": "Start/stop as a background daemon"
  },
  "stop": {
    "section": "Setup",
    "summary": "Start/stop as a background daemon"
  },
  "help": {
    "section": "Setup",
    "summary": "Find commands and inspect the CLI catalog"
  },
  "mcp": {
    "section": "Setup",
    "summary": "Install and manage MCP client connections"
  },
  "site-health": {
    "section": "Page Health",
    "summary": "Crawl, score, and inspect site health evidence"
  },
  "keyword": {
    "section": "Projects",
    "summary": "Inspect and maintain tracked query evidence"
  },
  "measurement-plan": {
    "section": "Projects",
    "summary": "Configure properties, targets, markets and measurement plans"
  },
  "overview": {
    "section": "Monitoring",
    "summary": "Show the stored project overview"
  },
  "results": {
    "section": "Monitoring",
    "summary": "Read stored run and query results"
  },
  "sources": {
    "section": "Monitoring",
    "summary": "Read stored citation sources"
  },
  "citations": {
    "section": "Monitoring",
    "summary": "Read stored citation evidence"
  },
  "visibility-stats": {
    "section": "Monitoring",
    "summary": "Show stored mention and citation statistics"
  },
  "trends": {
    "section": "Monitoring",
    "summary": "Show the stored figures behind a dashboard trend card"
  },
  "visibility-compare": {
    "section": "Monitoring",
    "summary": "Compare stored mention and citation results"
  },
  "sentiment": {
    "section": "Monitoring",
    "summary": "Inspect and manage experimental sentiment measurement"
  },
  "ga": {
    "section": "Integrations",
    "summary": "Read and manage Google Analytics evidence"
  },
  "gbp": {
    "section": "Integrations",
    "summary": "Manage business profiles and stored evidence"
  },
  "google-ads": {
    "section": "Integrations",
    "summary": "Manage advertising connections and stored performance"
  },
  "gtm": {
    "section": "Integrations",
    "summary": "Manage tag manager accounts, containers and workspaces"
  },
  "conversion-tracking": {
    "section": "Integrations",
    "summary": "Configure and inspect conversion tracking"
  },
  "backlinks": {
    "section": "Integrations",
    "summary": "Inspect and sync stored backlink evidence"
  },
  "cdp": {
    "section": "Integrations",
    "summary": "Manage browser-backed provider connections"
  },
  "ads": {
    "section": "Integrations",
    "summary": "Manage advertising accounts, campaigns and performance"
  },
  "agent": {
    "section": "Automation",
    "summary": "Manage analyst agents and conversations"
  },
  "content": {
    "section": "Automation",
    "summary": "Create and manage content work"
  },
  "discover": {
    "section": "Automation",
    "summary": "Discover, inspect and promote query candidates"
  },
  "research": {
    "section": "Automation",
    "summary": "Research queries and inspect stored results"
  },
  "search": {
    "section": "Automation",
    "summary": "Search stored project evidence"
  },
  "get": {
    "section": "Automation",
    "summary": "Read a field from stored project evidence"
  },
  "key": {
    "section": "Admin",
    "summary": "Manage API keys and project scopes"
  },
  "user": {
    "section": "Admin",
    "summary": "Manage dashboard users"
  },
  "logs": {
    "section": "Admin",
    "summary": "Read stored runtime logs"
  },
  "feedback": {
    "section": "Admin",
    "summary": "Send product feedback"
  }
}

function catalogOptions(options: ParseArgsOptionsConfig): CliCatalogDto['globalOptions'] {
  return Object.entries(options).map(([name, option]) => ({ name, type: option.type, multiple: option.multiple ?? false }))
}

export function buildCliCatalog(specs: readonly CliCommandSpec[]): CliCatalogDto {
  const roots = [...new Set(specs.map(spec => spec.path[0]!))]
  const groups = roots.map(root => {
    const summary = CLI_ROOT_SUMMARIES[root]
    if (!summary) throw new Error(`Missing CLI root summary: ${root}`)
    return {
      root, ...summary,
      commands: specs.filter(spec => spec.path[0] === root).map(spec => ({
        id: spec.path.join('.'), path: [...spec.path], usage: commandUsage(spec),
        supportsDryRun: spec.supportsDryRun ?? false,
        ...(spec.windows ? { windows: [...spec.windows] } : {}),
        options: catalogOptions(commandOptions(spec)),
        access: resolveCliAccess(spec),
      })),
    }
  })
  return { version, globalOptions: catalogOptions({ ...CLI_GLOBAL_OPTIONS, help: { type: 'boolean' }, version: { type: 'boolean' } }), groups }
}

export function renderTopLevelHelp(catalog: CliCatalogDto): string {
  const sections = ['Setup', 'Page Health', 'Projects', 'Monitoring', 'Config-as-Code', 'Integrations', 'Automation', 'Admin']
  const lines = ["cnry - Page Health and AI visibility CLI   ('canonry' also works)", '', 'Usage:  cnry <command> [options]', '']
  for (const section of [...new Set([...sections, ...catalog.groups.map(group => group.section)])]) {
    const groups = catalog.groups.filter(group => group.section === section)
    if (!groups.length) continue
    lines.push(`${section}:`, ...groups.map(group => `  ${group.root.padEnd(22)}${group.summary}`), '')
  }
  lines.push('Global options:',
    '  --format json         Machine-readable output: one JSON document (all commands)',
    '  --format jsonl        Machine-readable output: one record per line, no jq needed',
    '  --dry-run             Preview commands that support it',
    '  --stored-only         Refuse provider and write operations',
    '  --access <mode>       Filter help/catalog by stored, live, or write access',
    '  --trace               Trace API requests to stderr',
    '  --help, -h            Show help (use with any command group)',
    '  --version, -v         Show version', '',
    "Run 'cnry <command> --help' for details on a specific command.")
  return lines.join('\n')
}

export function printCliCatalog(specs: readonly CliCommandSpec[], format: CliFormat, group?: string, access?: string): void {
  const catalog = buildCliCatalog(specs)
  if (access !== undefined && access !== OperationAccesses.stored && access !== OperationAccesses.live && access !== OperationAccesses.write) {
    throw usageError(`Unknown access filter: ${access}`, { details: { access } })
  }
  const knownGroup = group ? catalog.groups.find(entry => entry.root === group) : undefined
  if (group && !knownGroup) throw usageError(`Unknown command group: ${group}`, { details: { group, usage: 'canonry help [<group>] [--format json|jsonl]' } })
  if (access) {
    for (const entry of catalog.groups) entry.commands = entry.commands.filter(command => command.access === access)
    catalog.groups = catalog.groups.filter(entry => entry.commands.length > 0 || entry.root === group)
  }
  if (group) {
    catalog.groups = catalog.groups.filter(entry => entry.root === group)
  }
  if (format === 'json') console.log(JSON.stringify(catalog, null, 2))
  else if (format === 'jsonl') emitJsonl(catalog.groups.flatMap(entry => entry.commands.map(command => ({ root: entry.root, ...command }))))
  else if (group) printGroupHelp(group, specs, access as OperationAccess | undefined)
  else console.log(renderTopLevelHelp(catalog))
}
