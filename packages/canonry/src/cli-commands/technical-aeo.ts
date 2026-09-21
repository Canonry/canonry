import {
  technicalAeoCrawl,
  technicalAeoCrawlPages,
  technicalAeoChanges,
  technicalAeoDeadLinks,
  technicalAeoInternalLinks,
  technicalAeoLinkNeighbors,
  technicalAeoPageAudit,
  technicalAeoPath,
  technicalAeoPages,
  technicalAeoProgress,
  technicalAeoRun,
  technicalAeoScore,
  technicalAeoStructure,
  technicalAeoSubgraph,
  technicalAeoTrend,
} from '../commands/technical-aeo.js'
import { CliError, usageError } from '../cli-error.js'
import type { CliCommandInput, CliCommandSpec } from '../cli-dispatch.js'
import {
  getBoolean,
  getString,
  parseIntegerOption,
  requireProject,
  requireStringOption,
  stringOption,
} from '../cli-command-helpers.js'

function parseOptionalBoolean(
  input: CliCommandInput,
  key: string,
  config: { command: string; usage: string },
): boolean | undefined {
  const value = getString(input.values, key)
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw usageError(`Error: --${key} must be true or false\nUsage: ${config.usage}`, {
    message: `--${key} must be true or false`,
    details: { command: config.command, usage: config.usage, option: key, value },
  })
}

function isSiteHealthScope(value: string | undefined): value is 'all' | 'pages' | 'links' {
  return value === 'all' || value === 'pages' || value === 'links'
}

function isSiteHealthChange(value: string | undefined): value is 'all' | 'added' | 'removed' | 'changed' {
  return value === 'all' || value === 'added' || value === 'removed' || value === 'changed'
}

const TECHNICAL_AEO_CLI_COMMANDS_BASE: readonly CliCommandSpec[] = [
  {
    path: ['technical-aeo', 'score'],
    usage: 'canonry technical-aeo score <project> [--run-id <id>] [--format json]',
    options: {
      'run-id': stringOption(),
    },
    run: async (input) => {
      const project = requireProject(
        input,
        'technical-aeo.score',
        'canonry technical-aeo score <project> [--run-id <id>] [--format json]',
      )
      await technicalAeoScore(project, { runId: getString(input.values, 'run-id'), format: input.format })
    },
  },
  {
    path: ['technical-aeo', 'pages'],
    usage: 'canonry technical-aeo pages <project> [--run-id <id>] [--status success|error] [--sort score-asc|score-desc|url] [--limit <n>] [--format json|jsonl]',
    options: {
      'run-id': stringOption(),
      status: stringOption(),
      sort: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo pages <project> [--run-id <id>] [--status success|error] [--sort score-asc|score-desc|url] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.pages', usage)
      await technicalAeoPages(project, {
        runId: getString(input.values, 'run-id'),
        status: getString(input.values, 'status'),
        sort: getString(input.values, 'sort'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'technical-aeo.pages',
          usage,
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'trend'],
    usage: 'canonry technical-aeo trend <project> [--limit <n>] [--format json|jsonl]',
    options: {
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo trend <project> [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.trend', usage)
      await technicalAeoTrend(project, {
        limit: parseIntegerOption(input, 'limit', {
          command: 'technical-aeo.trend',
          usage,
          message: '--limit must be an integer',
        }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'run'],
    usage: 'canonry technical-aeo run <project> [--sitemap-url <url>] [--max-pages <n>] [--max-edges <n>] [--max-depth <n>] [--check-dead-links] [--wait] [--format json]',
    help: 'Start a Site Health crawl. No answer-engine provider is required. --wait polls for up to 15 minutes. Dead-link checking is off unless --check-dead-links is set.',
    options: {
      'sitemap-url': stringOption(),
      limit: stringOption(),
      'max-pages': stringOption(),
      'max-edges': stringOption(),
      'max-depth': stringOption(),
      'check-dead-links': { type: 'boolean', default: false },
      wait: { type: 'boolean', default: false },
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo run <project> [--sitemap-url <url>] [--max-pages <n>] [--max-edges <n>] [--max-depth <n>] [--check-dead-links] [--wait] [--format json]'
      const project = requireProject(input, 'technical-aeo.run', usage)
      await technicalAeoRun(project, {
        sitemapUrl: getString(input.values, 'sitemap-url'),
        limit: parseIntegerOption(input, 'limit', {
          command: 'technical-aeo.run',
          usage,
          message: '--limit must be an integer',
        }),
        maxPages: parseIntegerOption(input, 'max-pages', {
          command: 'technical-aeo.run', usage, message: '--max-pages must be an integer',
        }),
        maxEdges: parseIntegerOption(input, 'max-edges', {
          command: 'technical-aeo.run', usage, message: '--max-edges must be an integer',
        }),
        maxDepth: parseIntegerOption(input, 'max-depth', {
          command: 'technical-aeo.run', usage, message: '--max-depth must be an integer',
        }),
        checkDeadLinks: getBoolean(input.values, 'check-dead-links'),
        wait: getBoolean(input.values, 'wait'),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'crawl'],
    usage: 'canonry technical-aeo crawl <project> [--run-id <id>] [--format json]',
    options: { 'run-id': stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo crawl <project> [--run-id <id>] [--format json]'
      const project = requireProject(input, 'technical-aeo.crawl', usage)
      await technicalAeoCrawl(project, { runId: getString(input.values, 'run-id'), format: input.format })
    },
  },
  {
    path: ['technical-aeo', 'progress'],
    usage: 'canonry technical-aeo progress <project> --run-id <id> [--format json]',
    options: { 'run-id': stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo progress <project> --run-id <id> [--format json]'
      const project = requireProject(input, 'technical-aeo.progress', usage)
      const runId = requireStringOption(input, 'run-id', {
        command: 'technical-aeo.progress',
        usage,
        message: '--run-id is required',
      })
      await technicalAeoProgress(project, { runId, format: input.format })
    },
  },
  {
    path: ['technical-aeo', 'subgraph'],
    usage: 'canonry technical-aeo subgraph <project> [--run-id <id>] [--node-key <key>|--url <url>] [--hops <n>] [--max-nodes <n>] [--max-edges <n>] [--format json]',
    options: {
      'run-id': stringOption(), 'node-key': stringOption(), url: stringOption(), hops: stringOption(),
      'max-nodes': stringOption(), 'max-edges': stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo subgraph <project> [--run-id <id>] [--node-key <key>|--url <url>] [--hops <n>] [--max-nodes <n>] [--max-edges <n>] [--format json]'
      const project = requireProject(input, 'technical-aeo.subgraph', usage)
      const nodeKey = getString(input.values, 'node-key')
      const url = getString(input.values, 'url')
      if (nodeKey && url) {
        throw usageError(`Error: --node-key and --url cannot be combined\nUsage: ${usage}`, {
          message: '--node-key and --url cannot be combined', details: { command: 'technical-aeo.subgraph', usage },
        })
      }
      await technicalAeoSubgraph(project, {
        runId: getString(input.values, 'run-id'), nodeKey, url,
        hops: parseIntegerOption(input, 'hops', { command: 'technical-aeo.subgraph', usage, message: '--hops must be an integer' }),
        maxNodes: parseIntegerOption(input, 'max-nodes', { command: 'technical-aeo.subgraph', usage, message: '--max-nodes must be an integer' }),
        maxEdges: parseIntegerOption(input, 'max-edges', { command: 'technical-aeo.subgraph', usage, message: '--max-edges must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'path'],
    usage: 'canonry technical-aeo path <project> (--to-node-key <key>|--to-url <url>) [--run-id <id>] [--from-node-key <key>|--from-url <url>] [--max-depth <n>] [--format json]',
    options: {
      'run-id': stringOption(), 'from-node-key': stringOption(), 'from-url': stringOption(),
      'to-node-key': stringOption(), 'to-url': stringOption(), 'max-depth': stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo path <project> (--to-node-key <key>|--to-url <url>) [--run-id <id>] [--from-node-key <key>|--from-url <url>] [--max-depth <n>] [--format json]'
      const project = requireProject(input, 'technical-aeo.path', usage)
      const fromNodeKey = getString(input.values, 'from-node-key')
      const fromUrl = getString(input.values, 'from-url')
      const toNodeKey = getString(input.values, 'to-node-key')
      const toUrl = getString(input.values, 'to-url')
      if (!toNodeKey && !toUrl) {
        throw usageError(`Error: --to-node-key or --to-url is required\nUsage: ${usage}`, {
          message: '--to-node-key or --to-url is required', details: { command: 'technical-aeo.path', usage },
        })
      }
      if ((fromNodeKey && fromUrl) || (toNodeKey && toUrl)) {
        throw usageError(`Error: node-key and URL selectors cannot be combined\nUsage: ${usage}`, {
          message: 'node-key and URL selectors cannot be combined', details: { command: 'technical-aeo.path', usage },
        })
      }
      await technicalAeoPath(project, {
        runId: getString(input.values, 'run-id'), fromNodeKey, fromUrl, toNodeKey, toUrl,
        maxDepth: parseIntegerOption(input, 'max-depth', { command: 'technical-aeo.path', usage, message: '--max-depth must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'changes'],
    usage: 'canonry technical-aeo changes <project> [--from-run-id <id>] [--to-run-id <id>] [--scope all|pages|links] [--change all|added|removed|changed] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: {
      'from-run-id': stringOption(), 'to-run-id': stringOption(), scope: stringOption(), change: stringOption(),
      cursor: stringOption(), limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo changes <project> [--from-run-id <id>] [--to-run-id <id>] [--scope all|pages|links] [--change all|added|removed|changed] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.changes', usage)
      const fromRunId = getString(input.values, 'from-run-id')
      const toRunId = getString(input.values, 'to-run-id')
      const scope = getString(input.values, 'scope')
      const change = getString(input.values, 'change')
      if (scope !== undefined && !isSiteHealthScope(scope)) {
        throw usageError(`Error: --scope must be all, pages, or links\nUsage: ${usage}`, {
          message: '--scope must be all, pages, or links', details: { command: 'technical-aeo.changes', usage, option: 'scope', value: scope },
        })
      }
      if (change !== undefined && !isSiteHealthChange(change)) {
        throw usageError(`Error: --change must be all, added, removed, or changed\nUsage: ${usage}`, {
          message: '--change must be all, added, removed, or changed', details: { command: 'technical-aeo.changes', usage, option: 'change', value: change },
        })
      }
      await technicalAeoChanges(project, {
        fromRunId, toRunId, scope,
        change,
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.changes', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'crawl-pages'],
    usage: 'canonry technical-aeo crawl-pages <project> [--run-id <id>] [--inventory-eligible true|false] [--fetch-state <state>] [--indexability-state <state>] [--audit-state <state>] [--sort url|path|score-asc|score-desc] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: {
      'run-id': stringOption(),
      'inventory-eligible': stringOption(),
      'fetch-state': stringOption(),
      'indexability-state': stringOption(),
      'audit-state': stringOption(),
      sort: stringOption(),
      cursor: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo crawl-pages <project> [--run-id <id>] [--inventory-eligible true|false] [--fetch-state <state>] [--indexability-state <state>] [--audit-state <state>] [--sort url|path|score-asc|score-desc] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.crawl-pages', usage)
      const sort = getString(input.values, 'sort')
      if (sort !== undefined && !['url', 'path', 'score-asc', 'score-desc'].includes(sort)) {
        throw usageError(`Error: --sort must be url, path, score-asc, or score-desc\nUsage: ${usage}`, {
          message: '--sort must be url, path, score-asc, or score-desc',
          details: { command: 'technical-aeo.crawl-pages', usage, option: 'sort', value: sort },
        })
      }
      await technicalAeoCrawlPages(project, {
        runId: getString(input.values, 'run-id'),
        inventoryEligible: parseOptionalBoolean(input, 'inventory-eligible', { command: 'technical-aeo.crawl-pages', usage }),
        fetchState: getString(input.values, 'fetch-state'),
        indexabilityState: getString(input.values, 'indexability-state'),
        auditState: getString(input.values, 'audit-state'),
        sort: sort as 'url' | 'path' | 'score-asc' | 'score-desc' | undefined,
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.crawl-pages', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'page-audit'],
    usage: 'canonry technical-aeo page-audit <project> (--node-key <key>|--url <url>) [--run-id <id>] [--format json]',
    options: { 'run-id': stringOption(), 'node-key': stringOption(), url: stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo page-audit <project> (--node-key <key>|--url <url>) [--run-id <id>] [--format json]'
      const project = requireProject(input, 'technical-aeo.page-audit', usage)
      const nodeKey = getString(input.values, 'node-key')
      const url = getString(input.values, 'url')
      if (!nodeKey && !url) {
        throw usageError(`Error: --node-key or --url is required\nUsage: ${usage}`, {
          message: '--node-key or --url is required', details: { command: 'technical-aeo.page-audit', usage },
        })
      }
      if (nodeKey && url) {
        throw usageError(`Error: --node-key and --url cannot be combined\nUsage: ${usage}`, {
          message: '--node-key and --url cannot be combined', details: { command: 'technical-aeo.page-audit', usage },
        })
      }
      await technicalAeoPageAudit(project, {
        runId: getString(input.values, 'run-id'),
        nodeKey,
        url,
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'structure'],
    usage: 'canonry technical-aeo structure <project> [--run-id <id>] [--parent-path <path>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: { 'run-id': stringOption(), 'parent-path': stringOption(), cursor: stringOption(), limit: stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo structure <project> [--run-id <id>] [--parent-path <path>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.structure', usage)
      await technicalAeoStructure(project, {
        runId: getString(input.values, 'run-id'),
        parentPath: getString(input.values, 'parent-path'),
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.structure', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'links'],
    usage: 'canonry technical-aeo links <project> [--run-id <id>] [--source-url <url>] [--target-url <url>] [--followable|--nofollow] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: {
      'run-id': stringOption(),
      'source-url': stringOption(),
      'target-url': stringOption(),
      followable: { type: 'boolean', default: false },
      nofollow: { type: 'boolean', default: false },
      cursor: stringOption(),
      limit: stringOption(),
    },
    run: async (input) => {
      const usage = 'canonry technical-aeo links <project> [--run-id <id>] [--source-url <url>] [--target-url <url>] [--followable|--nofollow] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.links', usage)
      const followable = getBoolean(input.values, 'followable')
      const nofollow = getBoolean(input.values, 'nofollow')
      if (followable && nofollow) {
        throw usageError(`Error: --followable and --nofollow cannot be combined\nUsage: ${usage}`, {
          message: '--followable and --nofollow cannot be combined',
          details: { command: 'technical-aeo.links', usage },
        })
      }
      await technicalAeoInternalLinks(project, {
        runId: getString(input.values, 'run-id'),
        sourceUrl: getString(input.values, 'source-url'),
        targetUrl: getString(input.values, 'target-url'),
        followable: followable ? true : nofollow ? false : undefined,
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.links', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'links', 'neighbors'],
    usage: 'canonry technical-aeo links neighbors <project> (--node-key <key>|--url <url>) [--run-id <id>] [--limit <n>] [--format json]',
    options: { 'run-id': stringOption(), 'node-key': stringOption(), url: stringOption(), limit: stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo links neighbors <project> (--node-key <key>|--url <url>) [--run-id <id>] [--limit <n>] [--format json]'
      const project = requireProject(input, 'technical-aeo.links.neighbors', usage)
      const nodeKey = getString(input.values, 'node-key')
      const url = getString(input.values, 'url')
      if (!nodeKey && !url) {
        throw usageError(`Error: --node-key or --url is required\nUsage: ${usage}`, {
          message: '--node-key or --url is required', details: { command: 'technical-aeo.links.neighbors', usage },
        })
      }
      await technicalAeoLinkNeighbors(project, {
        runId: getString(input.values, 'run-id'),
        nodeKey,
        url,
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.links.neighbors', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
  {
    path: ['technical-aeo', 'dead-links'],
    usage: 'canonry technical-aeo dead-links <project> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
    options: { 'run-id': stringOption(), cursor: stringOption(), limit: stringOption() },
    run: async (input) => {
      const usage = 'canonry technical-aeo dead-links <project> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]'
      const project = requireProject(input, 'technical-aeo.dead-links', usage)
      await technicalAeoDeadLinks(project, {
        runId: getString(input.values, 'run-id'),
        cursor: getString(input.values, 'cursor'),
        limit: parseIntegerOption(input, 'limit', { command: 'technical-aeo.dead-links', usage, message: '--limit must be an integer' }),
        format: input.format,
      })
    },
  },
]

function siteHealthAlias(
  sourcePath: readonly string[],
  path: string[],
  usage: string,
): CliCommandSpec {
  const source = TECHNICAL_AEO_CLI_COMMANDS_BASE.find(
    (candidate) => candidate.path.join(' ') === sourcePath.join(' '),
  )
  if (!source) throw new Error(`Missing Site Health compatibility source: ${sourcePath.join(' ')}`)
  return {
    ...source,
    path,
    usage,
    run: async (input) => {
      try {
        await source.run(input)
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== 'CLI_USAGE_ERROR') throw error
        const firstLine = error.displayMessage?.split('\n', 1)[0] ?? `Error: ${error.message}`
        throw usageError(`${firstLine}\nUsage: ${usage}`, {
          message: error.message,
          details: { ...error.details, command: path.join('.'), usage },
        })
      }
    },
  }
}

const SITE_HEALTH_COMPATIBILITY_COMMANDS: readonly CliCommandSpec[] = [
  siteHealthAlias(
    ['technical-aeo', 'crawl'],
    ['site-health', 'overview'],
    'canonry site-health overview <project> [--run-id <id>] [--format json]',
  ),
  siteHealthAlias(
    ['technical-aeo', 'crawl-pages'],
    ['site-health', 'pages'],
    'canonry site-health pages <project> [--run-id <id>] [--inventory-eligible true|false] [--fetch-state <state>] [--indexability-state <state>] [--audit-state <state>] [--sort url|path|score-asc|score-desc] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
  ),
  siteHealthAlias(
    ['technical-aeo', 'page-audit'],
    ['site-health', 'page-audit'],
    'canonry site-health page-audit <project> (--node-key <key>|--url <url>) [--run-id <id>] [--format json]',
  ),
  siteHealthAlias(
    ['technical-aeo', 'structure'],
    ['site-health', 'structure'],
    'canonry site-health structure <project> [--run-id <id>] [--parent-path <path>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
  ),
  siteHealthAlias(
    ['technical-aeo', 'links'],
    ['site-health', 'links'],
    'canonry site-health links <project> [--run-id <id>] [--source-url <url>] [--target-url <url>] [--followable|--nofollow] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
  ),
  siteHealthAlias(
    ['technical-aeo', 'links', 'neighbors'],
    ['site-health', 'neighbors'],
    'canonry site-health neighbors <project> (--node-key <key>|--url <url>) [--run-id <id>] [--limit <n>] [--format json]',
  ),
  siteHealthAlias(
    ['technical-aeo', 'dead-links'],
    ['site-health', 'dead-links'],
    'canonry site-health dead-links <project> [--run-id <id>] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
  ),
  siteHealthAlias(
    ['technical-aeo', 'subgraph'],
    ['site-health', 'subgraph'],
    'canonry site-health subgraph <project> [--run-id <id>] [--node-key <key>|--url <url>] [--hops <n>] [--max-nodes <n>] [--max-edges <n>] [--format json]',
  ),
  siteHealthAlias(
    ['technical-aeo', 'path'],
    ['site-health', 'path'],
    'canonry site-health path <project> (--to-node-key <key>|--to-url <url>) [--run-id <id>] [--from-node-key <key>|--from-url <url>] [--max-depth <n>] [--format json]',
  ),
  siteHealthAlias(
    ['technical-aeo', 'changes'],
    ['site-health', 'changes'],
    'canonry site-health changes <project> [--from-run-id <id>] [--to-run-id <id>] [--scope all|pages|links] [--change all|added|removed|changed] [--cursor <cursor>] [--limit <n>] [--format json|jsonl]',
  ),
]

/** Site Health is the operator-facing name; technical-aeo commands remain compatible. */
export const TECHNICAL_AEO_CLI_COMMANDS: readonly CliCommandSpec[] = [
  ...TECHNICAL_AEO_CLI_COMMANDS_BASE,
  ...SITE_HEALTH_COMPATIBILITY_COMMANDS,
]
